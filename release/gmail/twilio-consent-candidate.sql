-- Review-only: no provider, paid number, SMS grant, activation, or production change.
-- Separate web request and signed inbound JOIN. No outbound confirmation message.
begin;
create table hag_private.sms_join_pending(
 request_id uuid primary key, destination text not null unique check(destination ~ '^[+]1[2-9][0-9]{9}$'),
 display_name text not null check(char_length(btrim(display_name)) between 1 and 120),
 sports text[] not null, updates text[] not null, code_hash bytea not null unique check(octet_length(code_hash)=32),
 version text not null check(version='hag-sports-v1'), requested_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '15 minutes'
);
create table hag_private.sms_provider_events(
 message_sid text primary key check(message_sid ~ '^SM[0-9A-Fa-f]{32}$'),
 destination text not null check(destination ~ '^[+]1[2-9][0-9]{9}$'),
 kind text not null check(kind in ('stop','start','help','join','review')),
 received_at timestamptz not null default clock_timestamp()
);
create table hag_private.sms_provider_blocks(
 destination text primary key check(destination ~ '^[+]1[2-9][0-9]{9}$'),
 blocked_at timestamptz not null default clock_timestamp(),
 provider_unblocked_at timestamptz
);
create table hag_private.sms_review_queue(
 message_sid text primary key references hag_private.sms_provider_events(message_sid),
 reply_text text not null check(char_length(reply_text)<=1600),
 created_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz
);
create table hag_private.sms_confirmation_outbox(
 method_id uuid primary key references hag_private.hag_contact_methods(id),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
 state text not null default 'queued' check(state in ('queued','reserved','accepted','held','cancelled')),
 ticket uuid unique, reserved_at timestamptz, finished_at timestamptz
);
alter table hag_private.sms_review_queue enable row level security;
alter table hag_private.sms_review_queue force row level security;
alter table hag_private.sms_confirmation_outbox enable row level security;
alter table hag_private.sms_confirmation_outbox force row level security;
revoke all on hag_private.sms_review_queue,hag_private.sms_confirmation_outbox from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
alter table hag_private.sms_join_pending enable row level security;
alter table hag_private.sms_join_pending force row level security;
alter table hag_private.sms_provider_events enable row level security;
alter table hag_private.sms_provider_events force row level security;
alter table hag_private.sms_provider_blocks enable row level security;
alter table hag_private.sms_provider_blocks force row level security;
revoke all on hag_private.sms_join_pending,hag_private.sms_provider_events,hag_private.sms_provider_blocks from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
-- Accept a server-generated random code hash; browser sees only code, never a confirmation capability.
create function hag_private.sms_stage_join(p_id uuid,p_name text,p_adult boolean,p_dest text,p_sports text[],p_updates text[],p_consent boolean,p_version text,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_id is null or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'hag-sports-v1' or p_dest is null or p_dest !~ '^[+]1[2-9][0-9]{9}$' or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or not hag_private.sport_selection_valid(p_sports,p_updates) then return false;end if;
 if not hag_private.subscription_issue_budget('sms',p_dest) then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||p_dest,0));
 if exists(select 1 from hag_private.sms_provider_blocks where destination=p_dest) or exists(select 1 from hag_private.hag_contact_methods where channel='sms' and destination=p_dest) then return false;end if;
 delete from hag_private.sms_join_pending where destination=p_dest and expires_at<=clock_timestamp();
 insert into hag_private.sms_join_pending(request_id,destination,display_name,sports,updates,code_hash,version)
 values(p_id,p_dest,btrim(p_name),p_sports,p_updates,decode(p_hash,'hex'),p_version) on conflict do nothing;
 return found;
end$$;
-- Must only be called by a signature-validated provider adapter; no runtime grants yet.
create function hag_private.sms_record_inbound(p_sid text,p_dest text,p_kind text,p_code text default null,p_review text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare pending hag_private.sms_join_pending; m uuid; raw text;
begin
 if p_sid is null or p_sid !~ '^SM[0-9A-Fa-f]{32}$' or p_dest is null or p_dest !~ '^[+]1[2-9][0-9]{9}$' or p_kind is null or p_kind not in ('stop','start','help','join','review') then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||p_dest,0));
 insert into hag_private.sms_provider_events(message_sid,destination,kind) values(p_sid,p_dest,p_kind) on conflict do nothing;
 if not found then return true;end if;
 if p_kind='stop' then
  insert into hag_private.sms_provider_blocks(destination) values(p_dest) on conflict(destination) do update set blocked_at=clock_timestamp(),provider_unblocked_at=null;
  delete from hag_private.sms_join_pending where destination=p_dest;
  select id into m from hag_private.hag_contact_methods where channel='sms' and destination=p_dest for update;
  if m is not null then
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
   select id,'withdrawn','hag-sports-v1','Provider-confirmed SMS revocation.','provider_stop','sms' from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active');
   update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('pending','active');
   insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'stop',true) on conflict(contact_method_id,reason) do update set active=true;
   update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
  end if;
 elsif p_kind='review' then
  -- Unknown replies might be reasonable-language opt-outs. Conservatively stop
  -- marketing while a staff member reviews the actual text. Never auto-unblock.
  insert into hag_private.sms_review_queue(message_sid,reply_text) values(p_sid,left(coalesce(p_review,''),1600));
  insert into hag_private.sms_provider_blocks(destination) values(p_dest) on conflict(destination) do update set blocked_at=clock_timestamp(),provider_unblocked_at=null;
  delete from hag_private.sms_join_pending where destination=p_dest;
  select id into m from hag_private.hag_contact_methods where channel='sms' and destination=p_dest;
  if m is not null then
   insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'manual',true) on conflict(contact_method_id,reason) do update set active=true;
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
   select id,'withdrawn','hag-sports-v1','SMS reply requires manual review; marketing withdrawn conservatively.','manual_revocation','sms' from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active');
   update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('pending','active');
   update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
  end if;
 elsif p_kind='start' then
  update hag_private.sms_provider_blocks set provider_unblocked_at=clock_timestamp() where destination=p_dest;
 elsif p_kind='join' then
  if p_code is null or p_code !~ '^[a-f0-9]{24}$' or exists(select 1 from hag_private.sms_provider_blocks where destination=p_dest) then return true;end if;
  select * into pending from hag_private.sms_join_pending where destination=p_dest and code_hash=extensions.digest(p_code,'sha256') and expires_at>clock_timestamp() for update;
  if pending.request_id is null then return true;end if;
  -- Existing atomic sport SMS confirmation remains authoritative; the raw capability
  -- never leaves this transaction. Any failed creation/confirmation rolls back.
  raw:=hag_private.sport_sms_signup(pending.request_id,pending.display_name,true,p_dest,pending.sports,pending.updates,true,pending.version);
  if raw is null or not hag_private.sport_sms_confirm(raw) then raise exception 'SMS confirmation unavailable';end if;
  select id into m from hag_private.hag_contact_methods where channel='sms' and destination=p_dest;
  insert into hag_private.sms_confirmation_outbox(method_id) values(m) on conflict do nothing;
  delete from hag_private.sms_join_pending where request_id=pending.request_id;
 end if;
 if p_kind in ('stop','review') and m is not null then update hag_private.sms_confirmation_outbox set state='cancelled',finished_at=clock_timestamp() where method_id=m and state='queued';end if;
 return true;
end$;
-- Confirmation acceptance is separate from consent. No runtime grant until a verified
-- provider, independent SMS role, bounded budget, and final dispatch fence exist.
revoke all on function hag_private.sms_stage_join(uuid,text,boolean,text,text[],text[],boolean,text,text),hag_private.sms_record_inbound(text,text,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
commit;
