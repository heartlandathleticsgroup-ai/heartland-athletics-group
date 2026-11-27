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
 delete from hag_private.subscription_abuse where window_start<clock_timestamp()-interval '1 day';
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
 delete from hag_private.subscription_issue_keys where created_at<clock_timestamp()-interval '1 day';
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
