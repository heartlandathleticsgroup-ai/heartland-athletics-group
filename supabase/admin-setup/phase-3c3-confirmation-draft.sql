-- DRAFT ONLY. Apply after phase-3c3-pending-draft.sql in an isolated test transaction.
-- No public wrapper, no provider, no production deployment. All timestamps are server-side.
create table hag_private.subscription_capabilities (
 token_hash bytea primary key check(octet_length(token_hash)=32),
 method_id uuid not null references hag_private.hag_contact_methods(id) on delete restrict,
 purpose text not null check(purpose in ('confirm','manage','edit','unsubscribe')),
 snapshot uuid[] not null default '{}',
 expires_at timestamptz not null,
 used_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create index on hag_private.subscription_capabilities(method_id);
create index on hag_private.subscription_capabilities(expires_at);
create table hag_private.subscription_abuse (
 scope text not null, bucket text not null, window_start timestamptz not null,
 hits integer not null check(hits>0), primary key(scope,bucket,window_start)
);
create table hag_private.subscription_rate_key (
 singleton boolean primary key check(singleton), secret bytea not null check(octet_length(secret)=32)
);
insert into hag_private.subscription_rate_key values(true,extensions.gen_random_bytes(32));
alter table hag_private.subscription_capabilities enable row level security;
alter table hag_private.subscription_capabilities force row level security;
alter table hag_private.subscription_abuse enable row level security;
alter table hag_private.subscription_abuse force row level security;
alter table hag_private.subscription_rate_key enable row level security;
alter table hag_private.subscription_rate_key force row level security;
revoke all on hag_private.subscription_capabilities,hag_private.subscription_abuse,hag_private.subscription_rate_key from public,anon,authenticated,service_role;
-- Internal helpers are not executable by any API role.
create function hag_private.subscription_allow(p_scope text,p_bucket text,p_minutes integer,p_max integer)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare w timestamptz; n integer;
begin
 w:=to_timestamp(floor(extract(epoch from clock_timestamp())/(60*p_minutes))*(60*p_minutes));
 insert into hag_private.subscription_abuse(scope,bucket,window_start,hits) values(p_scope,p_bucket,w,1)
 on conflict(scope,bucket,window_start) do update set hits=least(hag_private.subscription_abuse.hits+1,p_max+1)
 returning hits into n;
 return n<=p_max;
end $$;
create function hag_private.subscription_issue_budget(p_channel text,p_destination text)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare k bytea; b text;
begin
 -- Global ceiling before allocating a destination bucket; serialize issuance.
 if not hag_private.subscription_allow('issue-global','all',1,30) then return false; end if;
 if not hag_private.subscription_allow('issue-hour','all',60,300) then return false; end if;
 select secret into strict k from hag_private.subscription_rate_key where singleton;
 b:=encode(extensions.hmac(convert_to(p_channel||':'||p_destination,'UTF8'),k,'sha256'),'hex');
 delete from hag_private.subscription_abuse where window_start<clock_timestamp()-interval '1 day';
 delete from hag_private.subscription_capabilities where expires_at<clock_timestamp()-interval '1 day';
 return hag_private.subscription_allow('issue-destination',b,15,3);
end $$;
create function hag_private.subscription_destination_valid(c text,d text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce((c='email' and char_length(d)<=254 and d=lower(btrim(d)) and d ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and d !~ '[[:cntrl:]]') or (c='sms' and d ~ '^[+][1-9][0-9]{7,14}$'),false)
$$;
create function hag_private.subscription_topics_valid(a text[])
returns boolean language sql stable set search_path='' as $$
 select coalesce(cardinality(a) between 0 and 9 and (cardinality(a)=0 or array_ndims(a)=1) and (select count(distinct x) from unnest(a) x)=cardinality(a) and not exists(select 1 from unnest(a) x where not exists(select 1 from hag_private.hag_topics t where t.code=x and t.purpose='subscription' and t.active and t.code in ('hag-announcements','enforcers-updates','enforcers-tryouts','gus-macker-local','gus-macker-registration','camps-clinics','tournaments-events','sponsorship-updates','volunteer-updates'))),false)
$$;
-- Withdrawal is allowed for retired topics, and does not depend on agreeing to new consent.
create function hag_private.subscription_removal_topics_valid(a text[])
returns boolean language sql stable set search_path='' as $
 select coalesce(cardinality(a) between 0 and 9 and (cardinality(a)=0 or array_ndims(a)=1) and (select count(distinct x) from unnest(a) x)=cardinality(a) and not exists(select 1 from unnest(a) x where not exists(select 1 from hag_private.hag_topics t where t.code=x and t.purpose='subscription')),false)
$;
revoke all on function hag_private.subscription_removal_topics_valid(text[]) from public,anon,authenticated,service_role;
create function hag_private.subscription_wording(c text)
returns text language sql immutable set search_path='' as $$
 select case c when 'email' then 'I agree to receive marketing email from Heartland Athletics Group for the email topics I select. I can unsubscribe at any time. Consent is optional.' when 'sms' then 'I agree to receive recurring automated marketing text messages from Heartland Athletics Group at the number I provide, for the SMS topics I select. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.' end
$$;
create function hag_private.subscription_new_token(m uuid,p text,s uuid[] default '{}')
returns text language plpgsql volatile security invoker set search_path='' as $$
declare raw text:=encode(extensions.gen_random_bytes(32),'hex');
begin
 insert into hag_private.subscription_capabilities(token_hash,method_id,purpose,snapshot,expires_at)
 values(extensions.digest(raw,'sha256'),m,p,s,clock_timestamp()+case when p='unsubscribe' then interval '60 days' when p='edit' then interval '15 minutes' else interval '30 minutes' end);
 return raw;
end $$;
-- Called after gateway validation, and the trusted server must deliver only to the exact destination.
-- The raw result is for the future delivery adapter ONLY, never an HTTP response or log.
create function hag_private.subscription_request(p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare m uuid; ids uuid[];
begin
 if not hag_private.subscription_destination_valid(p_channel,p_destination) then return null; end if;
 if not hag_private.subscription_issue_budget(p_channel,p_destination) then return null; end if;
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return null; end if;
 perform hag_private.stage_subscription_request(p_name,p_adult,p_channel,p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return null; end if;
 select array_agg(id order by id) into ids from hag_private.hag_subscriptions where contact_method_id=m and status='pending' and topic_code=any(p_topics) and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=hag_subscriptions.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(p_channel));
 if ids is null then return null; end if;
 return hag_private.subscription_new_token(m,'confirm',ids);
end $$;
create function hag_private.subscription_access_request(p_channel text,p_destination text,p_purpose text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare m uuid;
begin
 if not hag_private.subscription_destination_valid(p_channel,p_destination) or p_purpose is null or p_purpose not in ('manage','unsubscribe') then return null; end if;
 if not hag_private.subscription_issue_budget(p_channel,p_destination) then return null; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||p_channel||':'||p_destination,0));
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null then return null; end if;
 return hag_private.subscription_new_token(m,p_purpose);
end $$;
-- Lock destination BEFORE consuming the token; all future writers must use same lock.
create function hag_private.subscription_take(p_raw text,p_purpose text)
returns hag_private.subscription_capabilities language plpgsql volatile security invoker set search_path='' as $$
declare cap hag_private.subscription_capabilities; c text; d text; h bytea;
begin
 if p_raw is null or p_raw !~ '^[0-9a-f]{64}$' then return null; end if;
 h:=extensions.digest(p_raw,'sha256');
 select t.* into cap from hag_private.subscription_capabilities t where t.token_hash=h and t.purpose=p_purpose and t.used_at is null and t.expires_at>clock_timestamp();
 if cap.method_id is null then return null; end if;
 select channel,destination into c,d from hag_private.hag_contact_methods where id=cap.method_id;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||c||':'||d,0));
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where token_hash=h and purpose=p_purpose and used_at is null and expires_at>clock_timestamp() returning * into cap;
 return cap;
end $$;
create function hag_private.subscription_redeem(p_raw text,p_purpose text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare cap hag_private.subscription_capabilities; c text; row_s record; ev uuid; result jsonb; suppressed boolean; confirmed_count integer:=0;
begin
 if p_purpose is null or p_purpose not in ('confirm','manage','unsubscribe') then return null; end if;
 -- Unsubscribe must not be blocked by a shared global counter. Future gateway still bounds requests.
 if p_purpose<>'unsubscribe' and not hag_private.subscription_allow('redeem-global','all',1,120) then return null; end if;
 cap:=hag_private.subscription_take(p_raw,p_purpose);
 if cap.method_id is null then return null; end if;
 select channel into c from hag_private.hag_contact_methods where id=cap.method_id;
 select exists(select 1 from hag_private.hag_suppressions where contact_method_id=cap.method_id and active) into suppressed;
 if p_purpose='unsubscribe' then
  for row_s in select id from hag_private.hag_subscriptions where contact_method_id=cap.method_id and status in ('pending','active') loop
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(row_s.id,'withdrawn','draft-3c3-v1','Verified link: unsubscribe from all marketing on this channel.','unsubscribe',c);
   update hag_private.hag_subscriptions set status='withdrawn' where id=row_s.id;
  end loop;
  insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(cap.method_id,'unsubscribe',true) on conflict(contact_method_id,reason) do update set active=true;
  update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=cap.method_id and used_at is null and purpose<>'unsubscribe';
  return jsonb_build_object('ok',true);
 end if;
 if p_purpose='confirm' then
  if suppressed then return null; end if;
  for row_s in select s.id,s.topic_code from hag_private.hag_subscriptions s join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose where s.contact_method_id=cap.method_id and s.id=any(cap.snapshot) and s.status='pending' and t.active and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(c)) loop
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(row_s.id,'confirmed','draft-3c3-v1',hag_private.subscription_wording(c),case when c='email' then 'email_confirmation' else 'sms_confirmation' end,c) returning id into ev;
   update hag_private.hag_subscriptions set status='active',confirmation_event_id=ev where id=row_s.id;
   confirmed_count:=confirmed_count+1;
  end loop;
  if confirmed_count=0 then return null; end if;
  update hag_private.hag_contact_methods set verified_at=coalesce(verified_at,clock_timestamp()) where id=cap.method_id;
  return jsonb_build_object('ok',true);
 end if;
 -- Manage proves control of one method only; give a fresh one-use edit capability.
 select coalesce(jsonb_agg(jsonb_build_object('topic',topic_code,'status',status) order by topic_code),'[]'::jsonb) into result from hag_private.hag_subscriptions where contact_method_id=cap.method_id;
 return jsonb_build_object('channel',c,'suppressed',suppressed,'preferences',result,'edit_token',hag_private.subscription_new_token(cap.method_id,'edit'));
end $$;
create function hag_private.subscription_edit(p_raw text,p_add text[],p_remove text[],p_adult boolean,p_consent boolean,p_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare cap hag_private.subscription_capabilities; c text; t text; sid uuid; st text; ev uuid; suppressed boolean;
begin
 if not hag_private.subscription_allow('redeem-global','all',1,120) then return false; end if;
 if not hag_private.subscription_topics_valid(p_add) or not hag_private.subscription_removal_topics_valid(p_remove) or p_add&&p_remove or cardinality(p_add)+cardinality(p_remove)=0 or (cardinality(p_add)>0 and (p_version is distinct from 'draft-3c3-v1' or p_adult is distinct from true or p_consent is distinct from true)) then return false; end if;
 cap:=hag_private.subscription_take(p_raw,'edit');
 if cap.method_id is null then return false; end if;
 select channel into c from hag_private.hag_contact_methods where id=cap.method_id;
 select exists(select 1 from hag_private.hag_suppressions where contact_method_id=cap.method_id and active) into suppressed;
 if suppressed and cardinality(p_add)>0 then return false; end if;
 foreach t in array p_remove loop
  select id,status into sid,st from hag_private.hag_subscriptions where contact_method_id=cap.method_id and topic_code=t;
  if sid is not null and st in ('pending','active') then
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sid,'withdrawn','draft-3c3-v1','Verified preference change: unsubscribe from this topic.','unsubscribe',c);
   update hag_private.hag_subscriptions set status='withdrawn' where id=sid;
  end if;
 end loop;
 foreach t in array p_add loop
  select id,status into sid,st from hag_private.hag_subscriptions where contact_method_id=cap.method_id and topic_code=t;
  if sid is null then
   insert into hag_private.hag_subscriptions(contact_method_id,channel,topic_code,status) values(cap.method_id,c,t,'pending') returning id into sid;
   st:='pending';
  end if;
  if st<>'active' then
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sid,'requested','draft-3c3-v1',hag_private.subscription_wording(c),'website',c);
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sid,'confirmed','draft-3c3-v1',hag_private.subscription_wording(c),case when c='email' then 'email_confirmation' else 'sms_confirmation' end,c) returning id into ev;
   update hag_private.hag_subscriptions set status='active',confirmation_event_id=ev where id=sid;
  end if;
 end loop;
 update hag_private.hag_contact_methods set verified_at=coalesce(verified_at,clock_timestamp()) where id=cap.method_id;
 -- Prevent stale edit/confirm capabilities from undoing a verified preference change.
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=cap.method_id and used_at is null and purpose in ('manage','edit');
 -- Confirmation snapshots remain safe: withdrawn rows cannot become active via an old link.
 -- Invalidate snapshots that intersect a modified topic, preserving unrelated pending links.
 update hag_private.subscription_capabilities k set used_at=clock_timestamp() where k.method_id=cap.method_id and k.used_at is null and k.purpose='confirm' and exists(select 1 from hag_private.hag_subscriptions s where s.contact_method_id=cap.method_id and s.id=any(k.snapshot) and s.topic_code=any(p_add||p_remove));
 return true;
end $$;
revoke all on function hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text) from service_role;
revoke all on function hag_private.subscription_allow(text,text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_issue_budget(text,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_destination_valid(text,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_topics_valid(text[]) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_wording(text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_new_token(uuid,text,uuid[]) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_take(text,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_request(text,boolean,text,text,text[],boolean,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_access_request(text,text,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_redeem(text,text) from public,anon,authenticated,service_role;
revoke all on function hag_private.subscription_edit(text,text[],text[],boolean,boolean,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_request(text,boolean,text,text,text[],boolean,text) to service_role;
grant execute on function hag_private.subscription_access_request(text,text,text) to service_role;
grant execute on function hag_private.subscription_redeem(text,text) to service_role;
grant execute on function hag_private.subscription_edit(text,text[],text[],boolean,boolean,text) to service_role;
