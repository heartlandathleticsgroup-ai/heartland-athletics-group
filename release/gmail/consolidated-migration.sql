-- UNPUBLISHED E.9 release migration candidate. Do not apply to hosted database.
-- Atomic: historical draft definitions are replaced/removed before commit.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $qa$
begin
 if to_regclass('hag_private.hag_subscriptions') is null or to_regclass('hag_private.subscription_capabilities') is not null or to_regclass('hag_private.gmail_connection') is not null then raise exception 'Unexpected existing schema; stop';end if;
 if exists(select 1 from hag_private.hag_subscriptions) then raise exception 'Unexpected existing subscriptions; manual migration required';end if;
end $qa$;
-- DRAFT: no production installation or public HTTP route approved.
-- One destination per invocation, no cross-channel linking without verified control.
-- Caller must be a future reviewed server gateway with abuse controls.
create function hag_private.stage_subscription_request(p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns void language plpgsql volatile security definer set search_path=''
as $fn$
declare method_id uuid; contact_id uuid; sub_id uuid; topic text; wording text; version constant text:='draft-3c3-v1';
begin
 if p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from version then raise exception 'Invalid request' using errcode='22023'; end if;
 if p_channel is null or p_channel not in ('email','sms') or p_destination is null then raise exception 'Invalid contact method' using errcode='22023'; end if;
 if (p_channel='email' and (char_length(p_destination)>254 or p_destination<>lower(btrim(p_destination)) or p_destination !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or p_destination ~ '[[:cntrl:]]')) or (p_channel='sms' and p_destination !~ '^[+][1-9][0-9]{7,14}$') then raise exception 'Invalid contact method' using errcode='22023'; end if;
 if p_topics is null or cardinality(p_topics) not between 1 and 9 or array_ndims(p_topics) is distinct from 1 or (select count(distinct x) from unnest(p_topics) x)<>cardinality(p_topics) or exists(select 1 from unnest(p_topics) x where x is null or not exists(select 1 from hag_private.hag_topics t where t.code=x and t.purpose='subscription' and t.active and t.code in ('hag-announcements','enforcers-updates','enforcers-tryouts','gus-macker-local','gus-macker-registration','camps-clinics','tournaments-events','sponsorship-updates','volunteer-updates'))) then raise exception 'Invalid topics' using errcode='22023'; end if;
 wording:=case p_channel when 'email' then 'I agree to receive marketing email from Heartland Athletics Group for the email topics I select. I can unsubscribe at any time. Consent is optional.' else 'I agree to receive recurring automated marketing text messages from Heartland Athletics Group at the number I provide, for the SMS topics I select. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.' end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||p_channel||':'||p_destination,0));
 select m.id into method_id from hag_private.hag_contact_methods m where m.channel=p_channel and m.destination=p_destination;
 if method_id is null then
  insert into hag_private.hag_contacts(display_name,adult_confirmed) values(btrim(p_name),true) returning id into contact_id;
  insert into hag_private.hag_contact_methods(contact_id,channel,destination) values(contact_id,p_channel,p_destination) returning id into method_id;
 end if;
 -- Existing identities are never edited. Active suppression blocks all new topic requests.
 if exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=method_id and x.active) then return; end if;
 foreach topic in array p_topics loop
  sub_id:=null;
  insert into hag_private.hag_subscriptions(contact_method_id,channel,topic_code,status) values(method_id,p_channel,topic,'pending') on conflict(contact_method_id,topic_code) do nothing returning id into sub_id;
  -- No changes to existing pending/active/withdrawn rows. Fresh re-consent requires verified flow.
  if sub_id is not null then
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sub_id,'requested',version,wording,'website',p_channel);
  end if;
 end loop;
end $fn$;
revoke all on function hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text) to service_role;
-- No public wrapper. No client grants, confirmation token, provider or message sending.


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
 -- Expired metadata is removed by the separate bounded maintenance operation.

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
returns boolean language sql stable set search_path='' as $withdrawal$
 select coalesce(cardinality(a) between 0 and 9 and (cardinality(a)=0 or array_ndims(a)=1) and (select count(distinct x) from unnest(a) x)=cardinality(a) and not exists(select 1 from unnest(a) x where not exists(select 1 from hag_private.hag_topics t where t.code=x and t.purpose='subscription')),false)
$withdrawal$;
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


-- UNPUBLISHED: load after both preceding drafts, only in isolated rollback tests.
-- A trusted gateway alone calls these functions; never expose private schema to the Data API.
create table hag_private.subscription_issue_keys (
 request_id uuid not null, channel text not null check(channel in ('email','sms')),
 created_at timestamptz not null default clock_timestamp(),
 primary key(request_id,channel)
);
create index on hag_private.subscription_issue_keys(created_at);
alter table hag_private.subscription_issue_keys enable row level security;
alter table hag_private.subscription_issue_keys force row level security;
revoke all on hag_private.subscription_issue_keys from public,anon,authenticated,service_role;
create function hag_private.subscription_gateway_budget(p_source text,p_action text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare k bytea; bucket text;
begin
 -- Source is a canonical IP supplied by a TRUSTED runtime, never a public header.
 if p_source is null or char_length(p_source) not between 1 and 64 or p_action is null or p_action not in ('subscribe','access','inspect','confirm','manage','edit','unsubscribe') then return false; end if;
 select secret into strict k from hag_private.subscription_rate_key where singleton;
 if p_action<>'unsubscribe' and not hag_private.subscription_allow('gateway-global','all',1,240) then return false; end if;
 bucket:=encode(extensions.hmac(convert_to(p_source,'UTF8'),k,'sha256'),'hex');
 -- Maintenance runs outside request transactions.
 return hag_private.subscription_allow(case when p_action='unsubscribe' then 'gateway-optout-source' else 'gateway-source' end,bucket,1,20);
end $$;
create function hag_private.subscription_gateway_issue(p_id uuid,p_action text,p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare claimed uuid;
begin
 if p_id is null or p_action is null or p_action not in ('subscribe','access') or not hag_private.subscription_destination_valid(p_channel,p_destination) then return null; end if;
 -- Budget first: duplicate keys must not be a way around issuance throttles or storage bounds.
 if not hag_private.subscription_issue_budget(p_channel,p_destination) then return null; end if;
 if p_action='subscribe' and (p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 or p_purpose is distinct from 'confirm') then return null; end if;
 if p_action='access' and (p_purpose is null or p_purpose not in ('manage','unsubscribe')) then return null; end if;

 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,p_channel) on conflict do nothing returning request_id into claimed;
 if claimed is null then return null; end if;
 -- Prior request/access functions consume the issuance budget themselves. Use a private
 -- unmetered helper variant, not a second budget charge; revoke its API grants below.
 if p_action='subscribe' then return hag_private.subscription_request(p_name,p_adult,p_channel,p_destination,p_topics,p_consent,p_version); end if;
 return hag_private.subscription_access_request(p_channel,p_destination,p_purpose);
end $$;
revoke all on function hag_private.subscription_gateway_budget(text,text),hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_gateway_budget(text,text),hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text) to service_role;
revoke execute on function hag_private.subscription_request(text,boolean,text,text,text[],boolean,text),hag_private.subscription_access_request(text,text,text) from service_role;
-- Remove double charging from the now-private issuance helpers. Existing validation/locking remains.
create or replace function hag_private.subscription_request(p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare m uuid; ids uuid[];
begin
 if not hag_private.subscription_destination_valid(p_channel,p_destination) then return null; end if;
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return null; end if;
 perform hag_private.stage_subscription_request(p_name,p_adult,p_channel,p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return null; end if;
 select array_agg(id order by id) into ids from hag_private.hag_subscriptions where contact_method_id=m and status='pending' and topic_code=any(p_topics) and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=hag_subscriptions.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(p_channel));
 if ids is null then return null; end if;
 return hag_private.subscription_new_token(m,'confirm',ids);
end $$;
create or replace function hag_private.subscription_access_request(p_channel text,p_destination text,p_purpose text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare m uuid;
begin
 if not hag_private.subscription_destination_valid(p_channel,p_destination) or p_purpose is null or p_purpose not in ('manage','unsubscribe') then return null; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||p_channel||':'||p_destination,0));
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null then return null; end if;
 return hag_private.subscription_new_token(m,p_purpose);
end $$;

-- Non-consuming confirmation scope lookup; token possession is required.
-- The returned topics are ONLY currently eligible topics in the original snapshot.
create function hag_private.subscription_confirm_scope(p_raw text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 if p_raw is null or p_raw !~ '^[0-9a-f]{64}$' then return null; end if;
 if not hag_private.subscription_allow('redeem-global','all',1,120) then return null; end if;
 select jsonb_build_object('channel',m.channel,'topics',jsonb_agg(s.topic_code order by s.topic_code))
 into result
 from hag_private.subscription_capabilities k
 join hag_private.hag_contact_methods m on m.id=k.method_id
 join hag_private.hag_subscriptions s on s.contact_method_id=m.id and s.id=any(k.snapshot)
 join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose
 where k.token_hash=extensions.digest(p_raw,'sha256') and k.purpose='confirm' and k.used_at is null and k.expires_at>clock_timestamp()
 and s.status='pending' and t.active
 and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)
 and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(m.channel))
 group by m.channel;
 return result;
end $$;
revoke all on function hag_private.subscription_confirm_scope(text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_confirm_scope(text) to service_role;


-- DRAFT ONLY; apply to disposable database after earlier drafts.
-- A future runtime login would be provisioned separately with only membership in this role.
create role hag_subscription_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_subscription_runtime;
grant execute on function hag_private.subscription_gateway_budget(text,text),
 hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text),
 hag_private.subscription_confirm_scope(text),hag_private.subscription_redeem(text,text),
 hag_private.subscription_edit(text,text[],text[],boolean,boolean,text)
 to hag_subscription_runtime;
revoke execute on function hag_private.subscription_gateway_budget(text,text),
 hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text),
 hag_private.subscription_confirm_scope(text),hag_private.subscription_redeem(text,text),
 hag_private.subscription_edit(text,text[],text[],boolean,boolean,text) from service_role;
-- No public wrapper, LOGIN, password or production secret. Do not install on live database.


-- Unpublished; isolated test database only. No production migration.
create function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select coalesce(p_token ~ '^[0-9a-f]{64}$' and p_purpose in ('confirm','manage','unsubscribe') and exists(
 select 1 from hag_private.subscription_capabilities k
 join hag_private.hag_contact_methods m on m.id=k.method_id
 where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=p_purpose
 and k.used_at is null and k.expires_at>statement_timestamp()+interval '1 minute'
 and m.channel='email' and m.destination=p_destination
 and (p_purpose<>'confirm' or (
 not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)
 and exists(select 1 from hag_private.hag_subscriptions s join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose where s.contact_method_id=m.id and s.id=any(k.snapshot) and s.status='pending' and t.active
 and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(m.channel)))
 ))),false)
$elig$;
revoke all on function hag_private.subscription_email_delivery_eligible(text,text,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_email_delivery_eligible(text,text,text) to hag_subscription_runtime;
-- Bounded maintenance for ephemeral metadata only. Consent and suppression records untouched.
create role hag_subscription_maintenance nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_subscription_maintenance;
create function hag_private.subscription_metadata_cleanup()
returns jsonb language plpgsql volatile security definer set search_path='' as $cleanup$
declare a integer; b integer; c integer;
begin
 delete from hag_private.subscription_capabilities where token_hash in
 (select token_hash from hag_private.subscription_capabilities where expires_at<clock_timestamp()-interval '1 day' order by expires_at limit 500 for update skip locked);
 get diagnostics a=row_count;
 delete from hag_private.subscription_abuse where (scope,bucket,window_start) in
 (select scope,bucket,window_start from hag_private.subscription_abuse where window_start<clock_timestamp()-interval '1 day' order by window_start limit 500 for update skip locked);
 get diagnostics b=row_count;
 delete from hag_private.subscription_issue_keys where (request_id,channel) in
 (select request_id,channel from hag_private.subscription_issue_keys where created_at<clock_timestamp()-interval '1 day' order by created_at limit 500 for update skip locked);
 get diagnostics c=row_count;
 return jsonb_build_object('capabilities',a,'abuse',b,'issue_keys',c);
end $cleanup$;
revoke all on function hag_private.subscription_metadata_cleanup() from public,anon,authenticated,service_role,hag_subscription_runtime;
grant execute on function hag_private.subscription_metadata_cleanup() to hag_subscription_maintenance;


-- UNPUBLISHED synthetic-only outbox draft; load after email-readiness-draft.
-- The externally supplied 256-bit key is never stored in this database.
create table hag_private.subscription_email_outbox (
 id uuid primary key, request_id uuid unique not null, payload bytea, key_version text not null,
 state text not null default 'queued' check(state in ('queued','leased','retry','accepted','cancelled','expired','failed')),
 attempts integer not null default 0 check(attempts between 0 and 3),
 claims integer not null default 0 check(claims between 0 and 8),
 created_at timestamptz not null default clock_timestamp(), deadline timestamptz not null,
 next_at timestamptz not null default clock_timestamp(), lease uuid, lease_until timestamptz,
 finished_at timestamptz,
 check ((state in ('accepted','cancelled','expired','failed'))=(payload is null))
);
create index on hag_private.subscription_email_outbox(state,next_at);
create table hag_private.subscription_email_quota (
 period text not null, bucket date not null, reserved integer not null check(reserved>=0), primary key(period,bucket)
);
create table hag_private.subscription_email_sim_acceptance (
 job_id uuid primary key references hag_private.subscription_email_outbox(id) on delete cascade,
 accepted_at timestamptz not null default clock_timestamp()
);
create table hag_private.subscription_email_sim_events (
 event_id uuid primary key, job_id uuid not null references hag_private.subscription_email_outbox(id) on delete cascade,
 event_kind text not null check(event_kind in ('delivered','bounced')), received_at timestamptz not null default clock_timestamp()
);
create table hag_private.subscription_email_limits (
 singleton boolean primary key check(singleton), daily integer not null check(daily between 1 and 100),
 monthly integer not null check(monthly between 1 and 3000)
);
insert into hag_private.subscription_email_limits values(true,80,2400);
alter table hag_private.subscription_email_outbox enable row level security;
alter table hag_private.subscription_email_outbox force row level security;
revoke all on hag_private.subscription_email_outbox from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_quota enable row level security;
alter table hag_private.subscription_email_quota force row level security;
revoke all on hag_private.subscription_email_quota from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_sim_acceptance enable row level security;
alter table hag_private.subscription_email_sim_acceptance force row level security;
revoke all on hag_private.subscription_email_sim_acceptance from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_sim_events enable row level security;
alter table hag_private.subscription_email_sim_events force row level security;
revoke all on hag_private.subscription_email_sim_events from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_limits enable row level security;
alter table hag_private.subscription_email_limits force row level security;
revoke all on hag_private.subscription_email_limits from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
create role hag_email_sim_event_ingestor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_email_sim_event_ingestor;
create role hag_email_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_email_worker;
-- Atomic issue + outbox insert. A failed insert rolls back token issuance as well.
-- Reserved synthetic domains only. PGP symmetric authenticated integrity, external key.
create function hag_private.subscription_enqueue_email(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $fn$
declare raw text; j uuid:=gen_random_uuid();
begin
 if p_destination is null or p_destination !~ '^[a-z0-9._+%-]+@[a-z0-9.-]+[.]invalid$' or p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid isolated email configuration';end if;
 -- Serialize admission only; bounded backlog, no token created when full.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then return; end if;
 raw:=hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version,p_purpose);
 if raw is null then return; end if;
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose',p_purpose,'token',raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
end $fn$;
-- Claim commits a unique fencing token; expired leases can be reclaimed.
create function hag_private.subscription_email_claim()
returns jsonb language plpgsql volatile security definer set search_path='' as $fn$
declare j hag_private.subscription_email_outbox;
begin
 select * into j from hag_private.subscription_email_outbox
 where state in ('queued','retry','leased') and (state<>'leased' or lease_until<=clock_timestamp())
 and next_at<=clock_timestamp() order by next_at,id limit 1 for update skip locked;
 if j.id is null then return null;end if;
 if j.deadline<=clock_timestamp() or j.attempts>=3 or j.claims>=8 then
  update hag_private.subscription_email_outbox set state=case when exists(select 1 from hag_private.subscription_email_sim_acceptance a where a.job_id=j.id) then 'accepted' when deadline<=clock_timestamp() then 'expired' else 'failed' end,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;
  return null;
 end if;
 update hag_private.subscription_email_outbox set state='leased',claims=claims+1,lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'lease',j.lease,'key_version',j.key_version);
end $fn$;
-- Simulated dispatch/reconciliation only. No external call. Row lock fences stale workers.
-- Quota is charged for each unique accepted job, never for a simulated lost ACK.
create function hag_private.subscription_email_sim_step(p_job uuid,p_lease uuid,p_key text,p_key_version text,p_outcome text)
returns text language plpgsql volatile security definer set search_path='' as $fn$
declare j hag_private.subscription_email_outbox; v jsonb; d date; mo date; lim hag_private.subscription_email_limits; daily_n int; monthly_n int;
begin
 if p_outcome is null or p_outcome not in ('accept','ambiguous','transient','permanent') then return 'invalid';end if;
 select * into j from hag_private.subscription_email_outbox where id=p_job for update;
 if p_lease is null or j.id is null or j.state<>'leased' or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() then return 'stale';end if;
 -- Reconcile an already-accepted job before eligibility or expiry checks.
 if exists(select 1 from hag_private.subscription_email_sim_acceptance where job_id=j.id) then
  update hag_private.subscription_email_outbox set state='accepted',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'accepted';
 end if;
 if j.deadline<=clock_timestamp() then
  update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'expired';
 end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is distinct from j.key_version then return 'key-unavailable';end if;
 begin v:=extensions.pgp_sym_decrypt(j.payload,p_key)::jsonb;exception when others then return 'key-unavailable';end;
 -- Share the destination lock with confirmation, preference edits and withdrawal.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||(v->>'destination'),0));
 if j.lease_until<=clock_timestamp() then return 'stale'; end if;
 if j.deadline<=clock_timestamp() then
  update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'expired';
 end if;
 if not hag_private.subscription_email_delivery_eligible(v->>'token',v->>'destination',v->>'purpose') then
  update hag_private.subscription_email_outbox set state='cancelled',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'cancelled';
 end if;
 if p_outcome in ('accept','ambiguous') then
  -- Serialize the small quota ledger across all workers; UTC fixed calendar buckets.
  select * into strict lim from hag_private.subscription_email_limits where singleton for update;
  if j.lease_until<=clock_timestamp() then return 'stale';end if;
  if j.deadline<=clock_timestamp() then
   update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'expired';
  end if;
  d:=(clock_timestamp() at time zone 'UTC')::date;mo:=date_trunc('month',d::timestamp)::date;
  select coalesce((select reserved from hag_private.subscription_email_quota where period='day' and bucket=d),0) into daily_n;
  select coalesce((select reserved from hag_private.subscription_email_quota where period='month' and bucket=mo),0) into monthly_n;
  if daily_n>=lim.daily or monthly_n>=lim.monthly then
   update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'quota';
  end if;
  insert into hag_private.subscription_email_quota values('day',d,1),('month',mo,1) on conflict(period,bucket) do update set reserved=hag_private.subscription_email_quota.reserved+1;
  insert into hag_private.subscription_email_sim_acceptance(job_id) values(j.id);
 end if;
 if p_outcome='accept' or (p_outcome='ambiguous' and j.attempts=2) then
  update hag_private.subscription_email_outbox set state='accepted',attempts=attempts+1,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'accepted';
 end if;
 if p_outcome='permanent' or j.attempts=2 then
  update hag_private.subscription_email_outbox set state='failed',attempts=attempts+1,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'failed';
 end if;
 update hag_private.subscription_email_outbox set state='retry',attempts=attempts+1,next_at=clock_timestamp()+case when attempts=0 then interval '30 seconds' else interval '2 minutes' end,lease=null,lease_until=null where id=j.id;
 return 'retry';
end $fn$;
-- Synthetic event ingestion only; no provider signature or suppression sync asserted.
create function hag_private.subscription_email_sim_event(p_event uuid,p_job uuid,p_kind text)
returns boolean language plpgsql volatile security definer set search_path='' as $fn$
declare n int;
begin
 if p_event is null or p_kind is null or p_kind not in ('delivered','bounced') or not exists(select 1 from hag_private.subscription_email_sim_acceptance where job_id=p_job) then return false;end if;
 insert into hag_private.subscription_email_sim_events(event_id,job_id,event_kind) values(p_event,p_job,p_kind) on conflict do nothing;
 get diagnostics n=row_count;return n=1;
end $fn$;
create function hag_private.subscription_email_cleanup()
returns integer language plpgsql volatile security definer set search_path='' as $fn$
declare n int;
begin
 update hag_private.subscription_email_outbox set state=case when exists(select 1 from hag_private.subscription_email_sim_acceptance a where a.job_id=subscription_email_outbox.id) then 'accepted' else 'expired' end,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null
 where id in (select id from hag_private.subscription_email_outbox where state in ('queued','retry','leased') and deadline<=clock_timestamp() and (state<>'leased' or lease_until<=clock_timestamp()) limit 500 for update skip locked);
 delete from hag_private.subscription_email_outbox where id in (select id from hag_private.subscription_email_outbox where finished_at<clock_timestamp()-interval '1 day' limit 500 for update skip locked);
 get diagnostics n=row_count;
 delete from hag_private.subscription_email_quota where bucket<(clock_timestamp() at time zone 'UTC')::date-62;
 return n;
end $fn$;
revoke all on function hag_private.subscription_enqueue_email(uuid,text,text,boolean,text,text[],boolean,text,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_claim() from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_sim_event(uuid,uuid,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_cleanup() from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
grant execute on function hag_private.subscription_enqueue_email(uuid,text,text,boolean,text,text[],boolean,text,text,text,text) to hag_subscription_runtime;
grant execute on function hag_private.subscription_email_claim(),hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) to hag_email_worker;
grant execute on function hag_private.subscription_email_sim_event(uuid,uuid,text) to hag_email_sim_event_ingestor;
grant execute on function hag_private.subscription_email_cleanup() to hag_subscription_maintenance;

-- Atomic email is now the only issuance path for the runtime. Preserve SMS fixture flow
-- through a fixed-channel wrapper; never return a raw email capability to the gateway.
create function hag_private.subscription_gateway_issue_sms(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text)
returns text language plpgsql volatile security definer set search_path='' as $sms$
begin
 if p_destination is null or p_destination !~ '^[+]1[2-9][0-9]{2}55501[0-9]{2}$' then return null;end if;
 return hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'sms',p_destination,p_topics,p_consent,p_version,p_purpose);
end $sms$;
revoke all on function hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text) from public,anon,authenticated,service_role,hag_email_worker,hag_email_sim_event_ingestor,hag_subscription_maintenance;
grant execute on function hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text) to hag_subscription_runtime;
revoke execute on function hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text) from hag_subscription_runtime;
revoke execute on function hag_private.subscription_email_delivery_eligible(text,text,text) from hag_subscription_runtime;
-- Dedicated event ingestor is synthetic only; no public webhook or provider signature.
-- DRAFT ONLY. Load after prior outbox regression suite in disposable PostgreSQL.
-- Separate consent evidence from verified ownership; never fabricate an email confirmation.
alter table hag_private.hag_subscriptions add column email_opt_in_event_id uuid;
alter table hag_private.hag_subscriptions add column email_opt_in_event_kind text generated always as ('requested'::text) stored;
alter table hag_private.hag_subscriptions add constraint subscription_email_opt_in_fk foreign key(email_opt_in_event_id,id,email_opt_in_event_kind) references hag_private.hag_consent_events(id,subscription_id,event_kind);
alter table hag_private.hag_subscriptions add constraint subscription_email_opt_in_channel check(email_opt_in_event_id is null or channel='email');
alter table hag_private.hag_subscriptions drop constraint hag_subscriptions_check;
alter table hag_private.hag_subscriptions add constraint subscription_active_evidence check(status<>'active' or confirmation_event_id is not null or (channel='email' and email_opt_in_event_id is not null));
create function hag_private.subscription_email_opt_in(p_id uuid,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns void language plpgsql volatile security definer set search_path='' as $single$
declare claimed uuid; m uuid;
begin
 if p_id is null or p_destination is null or not hag_private.subscription_destination_valid('email',p_destination) or not hag_private.subscription_destination_valid('email',p_destination) or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return;end if;
 if not hag_private.subscription_issue_budget('email',p_destination) then return;end if;
 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,'email') on conflict do nothing returning request_id into claimed;
 if claimed is null then return;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 perform hag_private.stage_subscription_request(p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return;end if;
 update hag_private.hag_subscriptions s set status='active',email_opt_in_event_id=e.id
 from (select distinct on (subscription_id) id,subscription_id from hag_private.hag_consent_events where event_kind='requested' and source='website' and channel='email' and consent_version='draft-3c3-v1' and consent_text=hag_private.subscription_wording('email') order by subscription_id,occurred_at desc,id) e
 where s.contact_method_id=m and s.channel='email' and s.status='pending' and s.topic_code=any(p_topics) and e.subscription_id=s.id;
 -- No verification timestamp, confirmation event, capability, or outbox job.
end $single$;
revoke all on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) from public,anon,authenticated,service_role,hag_email_worker,hag_subscription_maintenance,hag_email_sim_event_ingestor;
grant execute on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) to hag_subscription_runtime;
create or replace function hag_private.subscription_enqueue_email(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $fn$
declare raw text; j uuid:=gen_random_uuid();
begin
 if p_action is distinct from 'access' or p_purpose is null or p_purpose not in ('manage','unsubscribe') then return;end if;
 if p_destination is null or not hag_private.subscription_destination_valid('email',p_destination) or p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid email configuration';end if;
 -- Serialize admission only; bounded backlog, no token created when full.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then return; end if;
 raw:=hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version,p_purpose);
 if raw is null then return; end if;
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose',p_purpose,'token',raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
end $fn$;

-- Disable any historical draft email confirmation capabilities and dispatch attempts.
update hag_private.subscription_capabilities k set used_at=clock_timestamp() from hag_private.hag_contact_methods m where k.method_id=m.id and m.channel='email' and k.purpose='confirm' and k.used_at is null;
create or replace function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select coalesce(p_token ~ '^[0-9a-f]{64}$' and p_purpose in ('manage','unsubscribe') and exists(
 select 1 from hag_private.subscription_capabilities k join hag_private.hag_contact_methods m on m.id=k.method_id
 where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=p_purpose and k.used_at is null
 and k.expires_at>statement_timestamp()+interval '1 minute' and m.channel='email' and m.destination=p_destination),false)
$elig$;
create or replace function hag_private.subscription_request(p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare m uuid; ids uuid[];
begin
 if p_channel is distinct from 'sms' or not hag_private.subscription_destination_valid(p_channel,p_destination) then return null; end if;
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return null; end if;
 perform hag_private.stage_subscription_request(p_name,p_adult,p_channel,p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return null; end if;
 select array_agg(id order by id) into ids from hag_private.hag_subscriptions where contact_method_id=m and status='pending' and topic_code=any(p_topics) and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=hag_subscriptions.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(p_channel));
 if ids is null then return null; end if;
 return hag_private.subscription_new_token(m,'confirm',ids);
end $$;
create or replace function hag_private.subscription_confirm_scope(p_raw text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 if p_raw is null or p_raw !~ '^[0-9a-f]{64}$' then return null; end if;
 if not hag_private.subscription_allow('redeem-global','all',1,120) then return null; end if;
 select jsonb_build_object('channel',m.channel,'topics',jsonb_agg(s.topic_code order by s.topic_code))
 into result
 from hag_private.subscription_capabilities k
 join hag_private.hag_contact_methods m on m.id=k.method_id
 join hag_private.hag_subscriptions s on s.contact_method_id=m.id and s.id=any(k.snapshot)
 join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose
 where k.token_hash=extensions.digest(p_raw,'sha256') and k.purpose='confirm' and k.used_at is null and k.expires_at>clock_timestamp()
 and m.channel='sms' and s.status='pending' and t.active
 and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)
 and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(m.channel))
 group by m.channel;
 return result;
end $$;
create or replace function hag_private.subscription_redeem(p_raw text,p_purpose text)
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
  if c is distinct from 'sms' or suppressed then return null; end if;
  for row_s in select s.id,s.topic_code from hag_private.hag_subscriptions s join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose where s.contact_method_id=cap.method_id and s.id=any(cap.snapshot) and s.status='pending' and t.active and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(c)) loop
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(row_s.id,'confirmed','draft-3c3-v1',hag_private.subscription_wording(c),'sms_confirmation',c) returning id into ev;
   update hag_private.hag_subscriptions set status='active',confirmation_event_id=ev where id=row_s.id;
   confirmed_count:=confirmed_count+1;
  end loop;
  if confirmed_count=0 then return null; end if;
  update hag_private.hag_contact_methods set verified_at=coalesce(verified_at,clock_timestamp()) where id=cap.method_id;
  return jsonb_build_object('ok',true);
 end if;
 -- Manage proves control of one method only; give a fresh one-use edit capability.
 update hag_private.hag_contact_methods set verified_at=coalesce(verified_at,clock_timestamp()) where id=cap.method_id;
 select coalesce(jsonb_agg(jsonb_build_object('topic',topic_code,'status',status) order by topic_code),'[]'::jsonb) into result from hag_private.hag_subscriptions where contact_method_id=cap.method_id;
 return jsonb_build_object('channel',c,'suppressed',suppressed,'preferences',result,'edit_token',hag_private.subscription_new_token(cap.method_id,'edit'));
end $$;
create or replace function hag_private.subscription_edit(p_raw text,p_add text[],p_remove text[],p_adult boolean,p_consent boolean,p_version text)
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
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sid,'requested','draft-3c3-v1',hag_private.subscription_wording(c),'website',c) returning id into ev;
   if c='email' then
    update hag_private.hag_subscriptions set status='active',email_opt_in_event_id=ev,confirmation_event_id=null where id=sid;
   else
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sid,'confirmed','draft-3c3-v1',hag_private.subscription_wording(c),'sms_confirmation',c) returning id into ev;
   update hag_private.hag_subscriptions set status='active',confirmation_event_id=ev where id=sid;
   end if;
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


-- UNPUBLISHED, synthetic-only final Gmail stage. Never install on hosted database.
-- All credentials/state encrypted by trusted server with external AES-GCM key.
create role hag_gmail_control nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role hag_gmail_dispatch nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_gmail_control,hag_gmail_dispatch;
create table hag_private.gmail_connection (
 singleton boolean primary key check(singleton), generation bigint not null default 0,
 enabled boolean not null default false, credential text, key_version text,
 check (not enabled or credential is not null),
 check ((credential is null)=(key_version is null))
);
insert into hag_private.gmail_connection(singleton) values(true);
create table hag_private.gmail_oauth_state (
 digest text primary key check(digest ~ '^[a-f0-9]{64}$'), actor uuid not null, session_id uuid not null,
 generation bigint not null, verifier text not null check(length(verifier)<=2048),
 expires_at timestamptz not null default clock_timestamp()+interval '5 minutes'
);
create table hag_private.gmail_dispatch_receipt (
 job_id uuid primary key, ticket uuid unique not null, generation bigint not null,
 outcome text not null check(outcome in ('ambiguous-hold-no-resend','accepted-not-delivered','authorization-required','hold-quota-or-policy-review','permanent-or-configuration-review')),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz, started_at timestamptz, message_digest text not null
);
alter table hag_private.gmail_connection enable row level security;
alter table hag_private.gmail_connection force row level security;
alter table hag_private.gmail_oauth_state enable row level security;
alter table hag_private.gmail_oauth_state force row level security;
alter table hag_private.gmail_dispatch_receipt enable row level security;
alter table hag_private.gmail_dispatch_receipt force row level security;
revoke all on hag_private.gmail_connection,hag_private.gmail_oauth_state,hag_private.gmail_dispatch_receipt from public,anon,authenticated,service_role,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance,hag_gmail_control,hag_gmail_dispatch;
-- Only the trusted server control role can bind an independently verified admin/session.
create function hag_private.gmail_begin(p_digest text,p_actor uuid,p_session uuid,p_verifier text)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare g bigint;
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_actor is null or p_session is null or p_verifier is null or length(p_verifier) not between 1 and 2048 then return null;end if;
 select generation into g from hag_private.gmail_connection where singleton and credential is null for update;
 if g is null then return null;end if;
 delete from hag_private.gmail_oauth_state where expires_at<=clock_timestamp() or actor=p_actor;
 if (select count(*) from hag_private.gmail_oauth_state)>=20 then return null;end if;
 insert into hag_private.gmail_oauth_state(digest,actor,session_id,generation,verifier) values(p_digest,p_actor,p_session,g,p_verifier);
 return g;
end $$;
create function hag_private.gmail_take(p_digest text,p_actor uuid,p_session uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r hag_private.gmail_oauth_state; g bigint;
begin
 select generation into g from hag_private.gmail_connection where singleton for update;
 delete from hag_private.gmail_oauth_state where digest=p_digest and actor=p_actor and session_id=p_session and generation=g and expires_at>clock_timestamp() returning * into r;
 if r.digest is null then return null;end if;
 return jsonb_build_object('generation',r.generation,'verifier',r.verifier);
end $$;
create function hag_private.gmail_store(p_generation bigint,p_credential text,p_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 if p_credential is null or length(p_credential) not between 1 and 16384 or p_version is null or p_version !~ '^[a-zA-Z0-9_-]{1,32}$' then return false;end if;
 update hag_private.gmail_connection set credential=p_credential,key_version=p_version,enabled=false,generation=generation+1 where singleton and generation=p_generation and credential is null;
 get diagnostics n=row_count;
 if n=1 then delete from hag_private.gmail_oauth_state;delete from hag_private.gmail_launch_grant;end if;
 return n=1;
end $$;
create function hag_private.gmail_status()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('connected',credential is not null,'enabled',enabled,'generation',generation) from hag_private.gmail_connection where singleton
$$;
create function hag_private.gmail_disable(p_disconnect boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r hag_private.gmail_connection;
begin
 select * into r from hag_private.gmail_connection where singleton for update;
 update hag_private.gmail_connection set enabled=false,generation=generation+1,credential=case when p_disconnect then null else credential end,key_version=case when p_disconnect then null else key_version end where singleton;
 delete from hag_private.gmail_oauth_state;
 delete from hag_private.gmail_launch_grant;
 -- Only control server can retrieve encrypted revoked credential, never the UI.
 return case when p_disconnect then jsonb_build_object('credential',r.credential,'key_version',r.key_version) else '{}'::jsonb end;
end $$;
-- TEST-ONLY enabling for simulated transport. No production enable route.
create function hag_private.gmail_enable_fixture(p_generation bigint)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 update hag_private.gmail_connection set enabled=true where singleton and generation=p_generation and credential is not null;
 get diagnostics n=row_count;return n=1;
end $$;
create function hag_private.gmail_claim()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 if not exists(select 1 from hag_private.gmail_connection where singleton and enabled) then return null;end if;
 return hag_private.subscription_email_claim();
end $$;
-- Reserve BEFORE any external call. Crash after reserve is held, never automatically resent.
create function hag_private.gmail_reserve(p_job uuid,p_lease uuid,p_key text,p_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j hag_private.subscription_email_outbox; c hag_private.gmail_connection; v jsonb; lim hag_private.subscription_email_limits; d date; mo date; ticket uuid:=gen_random_uuid();
begin
 select * into j from hag_private.subscription_email_outbox where id=p_job for update;
 if j.id is null or j.state<>'leased' or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 if p_key is null or p_key !~ '^[a-f0-9]{64}$' or p_version is distinct from j.key_version then return null;end if;
 begin v:=extensions.pgp_sym_decrypt(j.payload,p_key)::jsonb;exception when others then return null;end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||(v->>'destination'),0));
 select * into c from hag_private.gmail_connection where singleton for update;
 if (select count(*) from hag_private.gmail_dispatch_receipt where outcome='ambiguous-hold-no-resend' and reviewed_at is null)>=500 then return null;end if;
 if not c.enabled or c.credential is null or j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 if not hag_private.subscription_destination_valid('email',v->>'destination') or not hag_private.subscription_email_delivery_eligible(v->>'token',v->>'destination',v->>'purpose') then
  update hag_private.subscription_email_outbox set state='cancelled',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return null;
 end if;
 select * into strict lim from hag_private.subscription_email_limits where singleton for update;
 if j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 d:=(clock_timestamp() at time zone 'UTC')::date;mo:=date_trunc('month',d::timestamp)::date;
 if coalesce((select reserved from hag_private.subscription_email_quota where period='day' and bucket=d),0)>=lim.daily or coalesce((select reserved from hag_private.subscription_email_quota where period='month' and bucket=mo),0)>=lim.monthly then
  update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return null;
 end if;
 insert into hag_private.subscription_email_quota values('day',d,1),('month',mo,1) on conflict(period,bucket) do update set reserved=hag_private.subscription_email_quota.reserved+1;
 insert into hag_private.gmail_dispatch_receipt(job_id,ticket,generation,outcome,message_digest) values(j.id,ticket,c.generation,'ambiguous-hold-no-resend',encode(extensions.digest((v->>'destination')||':'||(v->>'purpose')||':'||(v->>'token'),'sha256'),'hex'));
 update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null,attempts=attempts+1 where id=j.id;
 return jsonb_build_object('id',j.id,'ticket',ticket,'generation',c.generation,'credential',c.credential,'key_version',c.key_version,'message',v);
end $$;
create function hag_private.gmail_dispatch_allowed(p_ticket uuid,p_generation bigint,p_destination text,p_purpose text,p_token text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int; c hag_private.gmail_connection;
begin
 if p_destination is null or p_purpose is null or p_token is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 select * into c from hag_private.gmail_connection where singleton for update;
 if not c.enabled or c.generation is distinct from p_generation or not hag_private.subscription_email_delivery_eligible(p_token,p_destination,p_purpose) then return false;end if;
 update hag_private.gmail_dispatch_receipt set started_at=clock_timestamp() where ticket=p_ticket and generation=p_generation and started_at is null and finished_at is null and created_at>clock_timestamp()-interval '30 seconds' and message_digest=encode(extensions.digest(p_destination||':'||p_purpose||':'||p_token,'sha256'),'hex');
 get diagnostics n=row_count;return n=1;
end $$;
create function hag_private.gmail_finish(p_ticket uuid,p_outcome text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare j uuid; g bigint;
begin
 if p_outcome is null or p_outcome not in ('ambiguous-hold-no-resend','accepted-not-delivered','authorization-required','hold-quota-or-policy-review','permanent-or-configuration-review') then return false;end if;
 perform 1 from hag_private.gmail_connection where singleton for update;
 update hag_private.gmail_dispatch_receipt set outcome=p_outcome,finished_at=clock_timestamp() where ticket=p_ticket and finished_at is null and (p_outcome<>'accepted-not-delivered' or started_at is not null) returning job_id,generation into j,g;
 if j is null then return false;end if;
 if p_outcome='accepted-not-delivered' then update hag_private.subscription_email_outbox set state='accepted' where id=j;end if;
 if p_outcome in ('authorization-required','hold-quota-or-policy-review') then update hag_private.gmail_connection set enabled=false,generation=generation+1 where singleton and generation=g;end if;
 return true;
end $$;
revoke all on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint),hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint,text,text,text),hag_private.gmail_finish(uuid,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint) to hag_gmail_control;
grant execute on function hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint,text,text,text),hag_private.gmail_finish(uuid,text) to hag_gmail_dispatch;
-- Final worker cannot bypass the durable pre-dispatch reservation via historical sim step.
revoke execute on function hag_private.subscription_email_claim(),hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) from hag_email_worker;

-- New read-only admin bridge uses the existing gate, not client assertions.
-- In production it must be invoked with the initiating user's verified JWT.
create function hag_private.gmail_admin_proof()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid uuid; recent timestamptz;
begin
 if uid is null or hag_private.admin_session_state() is distinct from 'authorized' or coalesce(claims->>'session_id','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then return null;end if;
 sid:=(claims->>'session_id')::uuid;
 -- The existing gate checks current active staff, auth.users, auth.sessions,
 -- verified TOTP enrollment, and approved passkey session where appropriate.
 select max(t.at) into recent from (
 -- Use the original factor assertion timestamp conservatively; refreshing a row must not extend step-up.
 select m.created_at as at from auth.mfa_amr_claims m
 where m.session_id=sid and m.authentication_method='totp' and claims->>'aal'='aal2'
 union all
 select g.verified_at from hag_private.hag_verified_passkey_sessions g
 join hag_private.hag_approved_passkeys a on a.credential_id=g.credential_id and a.user_id=g.user_id and a.revoked_at is null
 join auth.webauthn_credentials c on c.id=a.credential_id and c.user_id=a.user_id
 where g.session_id=sid and g.user_id=uid and exists(select 1 from auth.mfa_amr_claims m where m.session_id=sid and m.authentication_method='passkey')
 ) t where t.at<=now() and t.at>now()-interval '5 minutes';
 if recent is null then return null;end if;
 return jsonb_build_object('actor',uid,'session',sid,'gate','authorized','sessionActive',true,'stepUpAt',floor(extract(epoch from recent)*1000)::bigint);
end $$;
revoke all on function hag_private.gmail_admin_proof() from public,anon,authenticated,service_role;
grant execute on function hag_private.gmail_admin_proof() to authenticated;
create function public.hag_gmail_admin_proof()
returns jsonb language sql stable security invoker set search_path='' as $$ select hag_private.gmail_admin_proof() $$;
revoke all on function public.hag_gmail_admin_proof() from public,anon,authenticated,service_role;
grant execute on function public.hag_gmail_admin_proof() to authenticated;

-- Phase 3C.3E.7 callback binding and operator safeguards; isolated draft only.
create table hag_private.gmail_callback_flow (
 digest text primary key check(digest ~ '^[a-f0-9]{64}$'),
 state_digest text not null unique references hag_private.gmail_oauth_state(digest) on delete cascade,
 ciphertext text not null check(length(ciphertext) between 1 and 8192),
 expires_at timestamptz not null default clock_timestamp()+interval '5 minutes'
);
alter table hag_private.gmail_callback_flow enable row level security;
alter table hag_private.gmail_callback_flow force row level security;
revoke all on hag_private.gmail_callback_flow from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch;
create function hag_private.gmail_flow_put(p_digest text,p_state text,p_cipher text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_state is null or p_cipher is null or length(p_cipher) not between 1 and 8192 then return false;end if;
 perform 1 from hag_private.gmail_connection where singleton for update;
 if not exists(select 1 from hag_private.gmail_oauth_state s join hag_private.gmail_connection c on c.generation=s.generation where s.digest=p_state and s.expires_at>clock_timestamp() and c.credential is null) then return false;end if;
 delete from hag_private.gmail_callback_flow where expires_at<=clock_timestamp();
 insert into hag_private.gmail_callback_flow(digest,state_digest,ciphertext) values(p_digest,p_state,p_cipher) on conflict do nothing;
 return found;
end $$;
create function hag_private.gmail_flow_take(p_digest text,p_state text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare v text;
begin
 perform 1 from hag_private.gmail_connection where singleton for update;
 delete from hag_private.gmail_callback_flow where digest=p_digest and state_digest=p_state and expires_at>clock_timestamp() returning ciphertext into v;
 return v;
end $$;
-- Key rotation requires a disabled connection; ciphertext only, compare-and-swap.
create function hag_private.gmail_rotation_read()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('generation',generation,'credential',credential,'key_version',key_version)
 from hag_private.gmail_connection where singleton and not enabled and credential is not null
$$;
create function hag_private.gmail_rotation_commit(p_generation bigint,p_old_version text,p_new_version text,p_cipher text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_new_version is null or p_new_version !~ '^[A-Za-z0-9_-]{1,32}$' or p_new_version=p_old_version or p_cipher is null or length(p_cipher) not between 1 and 16384 then return false;end if;
 update hag_private.gmail_connection set credential=p_cipher,key_version=p_new_version,generation=generation+1
 where singleton and not enabled and credential is not null and generation=p_generation and key_version=p_old_version;
 if not found then return false;end if;
 delete from hag_private.gmail_oauth_state;
 delete from hag_private.gmail_launch_grant;
 return true;
end $$;
alter table hag_private.gmail_dispatch_receipt add column reviewed_at timestamptz,add column reviewed_by uuid,add column review_disposition text check(review_disposition in ('closed-unverified-no-resend','provider-acceptance-observed-no-resend'));
create function hag_private.gmail_review_list()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at,q.job_id),'[]'::jsonb) from (
 select job_id,created_at,outcome,started_at is not null as started from hag_private.gmail_dispatch_receipt
 where outcome='ambiguous-hold-no-resend' and reviewed_at is null and created_at<statement_timestamp()-interval '1 minute'
 order by created_at,job_id limit 50) q
$$;
create function hag_private.gmail_review_close(p_job uuid,p_actor uuid,p_disposition text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_actor is null or p_disposition is null or p_disposition not in ('closed-unverified-no-resend','provider-acceptance-observed-no-resend') then return false;end if;
 update hag_private.gmail_dispatch_receipt set reviewed_at=clock_timestamp(),reviewed_by=p_actor,review_disposition=p_disposition,finished_at=coalesce(finished_at,clock_timestamp())
 where job_id=p_job and outcome='ambiguous-hold-no-resend' and reviewed_at is null and created_at<clock_timestamp()-interval '1 minute';
 return found;
end $$;
-- Cleanup only expired state and old closed metadata; never remove open holds.
create function hag_private.gmail_cleanup()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 delete from hag_private.gmail_oauth_state where expires_at<=clock_timestamp();
 delete from hag_private.gmail_callback_flow where expires_at<=clock_timestamp();
 delete from hag_private.gmail_launch_grant where expires_at<=clock_timestamp();
 delete from hag_private.gmail_dispatch_receipt where job_id in (
 select job_id from hag_private.gmail_dispatch_receipt where
 (reviewed_at<clock_timestamp()-interval '90 days' or (outcome<>'ambiguous-hold-no-resend' and finished_at<clock_timestamp()-interval '90 days'))
 order by created_at limit 500 for update skip locked);
 get diagnostics n=row_count;return n;
end $$;
revoke all on function hag_private.gmail_flow_put(text,text,text),hag_private.gmail_flow_take(text,text),hag_private.gmail_rotation_read(),hag_private.gmail_rotation_commit(bigint,text,text,text),hag_private.gmail_review_list(),hag_private.gmail_review_close(uuid,uuid,text),hag_private.gmail_cleanup() from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance;
grant execute on function hag_private.gmail_flow_put(text,text,text),hag_private.gmail_flow_take(text,text),hag_private.gmail_rotation_read(),hag_private.gmail_rotation_commit(bigint,text,text,text),hag_private.gmail_review_list(),hag_private.gmail_review_close(uuid,uuid,text) to hag_gmail_control;
grant execute on function hag_private.gmail_cleanup() to hag_subscription_maintenance;

-- One-use launch handoff from static admin origin to a top-level runtime page.
-- The bearer stays encrypted server-side; the browser carries only an opaque grant.
create table hag_private.gmail_launch_grant(
 digest text primary key check(digest ~ '^[a-f0-9]{64}$'),
 actor uuid not null,session_id uuid not null,generation bigint not null,
 ciphertext text not null check(length(ciphertext) between 1 and 8192),
 expires_at timestamptz not null default clock_timestamp()+interval '60 seconds'
);
alter table hag_private.gmail_launch_grant enable row level security;
alter table hag_private.gmail_launch_grant force row level security;
revoke all on hag_private.gmail_launch_grant from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch;
create function hag_private.gmail_launch_put(p_digest text,p_actor uuid,p_session uuid,p_cipher text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare g bigint;
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_actor is null or p_session is null or p_cipher is null or length(p_cipher) not between 1 and 8192 then return false;end if;
 select generation into g from hag_private.gmail_connection where singleton and credential is null for update;
 if g is null then return false;end if;
 delete from hag_private.gmail_launch_grant where expires_at<=clock_timestamp() or actor=p_actor or generation<>g;
 if (select count(*) from hag_private.gmail_launch_grant)>=20 then return false;end if;
 insert into hag_private.gmail_launch_grant(digest,actor,session_id,generation,ciphertext) values(p_digest,p_actor,p_session,g,p_cipher) on conflict do nothing;
 return found;
end $$;
create function hag_private.gmail_launch_take(p_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare g bigint;v hag_private.gmail_launch_grant;
begin
 select generation into g from hag_private.gmail_connection where singleton and credential is null for update;
 if g is null then return null;end if;
 delete from hag_private.gmail_launch_grant where digest=p_digest and expires_at>clock_timestamp() and generation=g returning * into v;
 if v.digest is null then return null;end if;
 return jsonb_build_object('generation',v.generation,'ciphertext',v.ciphertext);
end $$;
revoke all on function hag_private.gmail_launch_put(text,uuid,uuid,text),hag_private.gmail_launch_take(text) from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance;
grant execute on function hag_private.gmail_launch_put(text,uuid,uuid,text),hag_private.gmail_launch_take(text) to hag_gmail_control;

create function hag_private.gmail_begin_at_generation(p_digest text,p_actor uuid,p_session uuid,p_verifier text,p_expected bigint)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare g bigint;
begin
 select generation into g from hag_private.gmail_connection where singleton for update;
 if g is distinct from p_expected or p_expected is null then return null;end if;
 return hag_private.gmail_begin(p_digest,p_actor,p_session,p_verifier);
end $$;
revoke all on function hag_private.gmail_begin_at_generation(text,uuid,uuid,text,bigint) from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance;
grant execute on function hag_private.gmail_begin_at_generation(text,uuid,uuid,text,bigint) to hag_gmail_control;


-- Final release state: simulation functions removed, Gmail remains disabled.
create or replace function hag_private.subscription_destination_valid(c text,d text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce((c='email' and char_length(d)<=254 and d=lower(btrim(d)) and char_length(split_part(d,'@',1)) between 1 and 64 and d ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and split_part(d,'@',1) not like '.%' and split_part(d,'@',1) not like '%.' and position('..' in d)=0 and not exists(select 1 from unnest(string_to_array(split_part(d,'@',2),'.')) as l where length(l)>63)) or (c='sms' and d ~ '^[+][1-9][0-9]{7,14}$'),false)
$$;

create or replace function hag_private.subscription_email_claim()
returns jsonb language plpgsql volatile security definer set search_path='' as $fn$
declare j hag_private.subscription_email_outbox;
begin
 select * into j from hag_private.subscription_email_outbox
 where state in ('queued','retry','leased') and (state<>'leased' or lease_until<=clock_timestamp())
 and next_at<=clock_timestamp() order by next_at,id limit 1 for update skip locked;
 if j.id is null then return null;end if;
 if j.deadline<=clock_timestamp() or j.attempts>=3 or j.claims>=8 then
  update hag_private.subscription_email_outbox set state=case when deadline<=clock_timestamp() then 'expired' else 'failed' end,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;
  return null;
 end if;
 update hag_private.subscription_email_outbox set state='leased',claims=claims+1,lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'lease',j.lease,'key_version',j.key_version);
end $fn$;

create or replace function hag_private.subscription_email_cleanup()
returns integer language plpgsql volatile security definer set search_path='' as $fn$
declare n int;
begin
 update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null
 where id in (select id from hag_private.subscription_email_outbox where state in ('queued','retry','leased') and deadline<=clock_timestamp() and (state<>'leased' or lease_until<=clock_timestamp()) limit 500 for update skip locked);
 delete from hag_private.subscription_email_outbox where id in (select id from hag_private.subscription_email_outbox where finished_at<clock_timestamp()-interval '1 day' limit 500 for update skip locked);
 get diagnostics n=row_count;
 delete from hag_private.subscription_email_quota where bucket<(clock_timestamp() at time zone 'UTC')::date-62;
 return n;
end $fn$;

drop function hag_private.gmail_enable_fixture(bigint);
drop function hag_private.subscription_email_sim_step(uuid,uuid,text,text,text);
drop function hag_private.subscription_email_sim_event(uuid,uuid,text);
drop table hag_private.subscription_email_sim_events;
drop table hag_private.subscription_email_sim_acceptance;
-- No real SMS provider is available. Keep its synthetic issuance inaccessible to release roles.
revoke execute on function hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text) from hag_subscription_runtime;
-- Separate no-login activation role; never granted to the web/worker login.
create role hag_gmail_release_operator nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_gmail_release_operator;
create function hag_private.gmail_enable_reviewed(p_generation bigint)
returns boolean language plpgsql volatile security definer set search_path='' as $fn$
begin
 update hag_private.gmail_connection set enabled=true where singleton and generation=p_generation and not enabled and credential is not null;
 return found;
end $fn$;
revoke all on function hag_private.gmail_enable_reviewed(bigint) from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance;
grant execute on function hag_private.gmail_enable_reviewed(bigint) to hag_gmail_release_operator;
-- Login identities are created NOLOGIN until separately approved private provisioning.
create role hag_gmail_control_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role hag_gmail_dispatch_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role hag_subscription_gateway_login nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant hag_gmail_control to hag_gmail_control_login;
grant hag_gmail_dispatch to hag_gmail_dispatch_login;
grant hag_subscription_runtime to hag_subscription_gateway_login;
-- Enforce a closed deployment state.
do $qa$
begin
 if exists(select 1 from hag_private.gmail_connection where enabled or credential is not null) then raise exception 'Unsafe initial connection';end if;
 if has_function_privilege('hag_gmail_control','hag_private.gmail_enable_reviewed(bigint)','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.gmail_enable_reviewed(bigint)','execute') or has_function_privilege('authenticated','hag_private.gmail_enable_reviewed(bigint)','execute') then raise exception 'Unsafe activation grant';end if;
end $qa$;
-- Public subscriber welcome batch: no hosted execution; keep deployment and send locks.
-- One durable marker per email contact method, surviving outbox cleanup.
alter table hag_private.hag_contact_methods add column email_welcome_queued_at timestamptz;
alter table hag_private.hag_contact_methods add constraint email_welcome_channel check(email_welcome_queued_at is null or channel='email');

create function hag_private.subscription_email_opt_in_welcome(p_id uuid,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $welcome$
declare claimed uuid; m uuid; manage_raw text; unsubscribe_raw text; j uuid:=gen_random_uuid(); n int;
begin
 if p_id is null or not hag_private.subscription_destination_valid('email',p_destination) or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return;end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64} or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32} then raise exception 'Invalid email configuration';end if;
 if not exists(select 1 from hag_private.gmail_connection where singleton and enabled and credential is not null) then raise exception 'Delivery not enabled';end if;
 -- Same admission and issuance lock order as secure-link requests.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then raise exception 'Admission unavailable';end if;
 if not hag_private.subscription_issue_budget('email',p_destination) then return;end if;
 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,'email') on conflict do nothing returning request_id into claimed;
 if claimed is null then return;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 perform hag_private.stage_subscription_request(p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return;end if;
 update hag_private.hag_subscriptions s set status='active',email_opt_in_event_id=e.id
 from (select distinct on (subscription_id) id,subscription_id from hag_private.hag_consent_events where event_kind='requested' and source='website' and channel='email' and consent_version='draft-3c3-v1' and consent_text=hag_private.subscription_wording('email') order by subscription_id,occurred_at desc,id) e
 where s.contact_method_id=m and s.channel='email' and s.status='pending' and s.topic_code=any(p_topics) and e.subscription_id=s.id;
 get diagnostics n=row_count;
 if n=0 then return;end if;
 update hag_private.hag_contact_methods set email_welcome_queued_at=clock_timestamp() where id=m and email_welcome_queued_at is null;
 if not found then return;end if;
 manage_raw:=hag_private.subscription_new_token(m,'manage');
 unsubscribe_raw:=hag_private.subscription_new_token(m,'unsubscribe');
 -- Bind both capabilities into the existing encrypted payload and dispatch digest.
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose','welcome','token',manage_raw||':'||unsubscribe_raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
 -- No ownership verification or confirmation event is fabricated. Transaction failure rolls back consent, marker, links and queue.
end $welcome$;
revoke all on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) from public,anon,authenticated,service_role,hag_email_worker,hag_subscription_maintenance,hag_email_sim_event_ingestor,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) to hag_subscription_runtime;
revoke execute on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) from hag_subscription_runtime;
-- Both links must remain usable, and the welcome must be cancelled if the email is suppressed before dispatch.
create or replace function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select case when p_purpose='welcome' then coalesce(p_token ~ '^[0-9a-f]{64}:[0-9a-f]{64} and exists(
  select 1 from hag_private.hag_contact_methods m
  join hag_private.subscription_capabilities k on k.method_id=m.id and k.purpose='manage' and k.token_hash=extensions.digest(split_part(p_token,':',1),'sha256')
  join hag_private.subscription_capabilities u on u.method_id=m.id and u.purpose='unsubscribe' and u.token_hash=extensions.digest(split_part(p_token,':',2),'sha256')
  where m.channel='email' and m.destination=p_destination and k.used_at is null and u.used_at is null
  and k.expires_at>statement_timestamp()+interval '1 minute' and u.expires_at>statement_timestamp()+interval '1 minute'
  and exists(select 1 from hag_private.hag_subscriptions s where s.contact_method_id=m.id and s.channel='email' and s.status='active')
  and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)),false)
 else coalesce(p_token ~ '^[0-9a-f]{64} and p_purpose in ('manage','unsubscribe') and exists(
  select 1 from hag_private.subscription_capabilities k join hag_private.hag_contact_methods m on m.id=k.method_id
  where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=p_purpose and k.used_at is null
  and k.expires_at>statement_timestamp()+interval '1 minute' and m.channel='email' and m.destination=p_destination),false) end
$elig$;

commit;
