-- Isolated least-privilege candidate. Apply only to disposable CI database.
-- All principals are NOLOGIN, have no members, and cannot turn on release gates.
-- No production endpoint, provider credentials, role passwords or public enrollment.
begin;
create role hag_sms_intake nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role hag_sms_inbound nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role hag_sms_receipts nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role hag_sms_dispatch nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create table hag_private.sms_enrollment_gate(
 singleton boolean primary key check(singleton),
 enabled boolean not null default false
);
insert into hag_private.sms_enrollment_gate values(true,false);
alter table hag_private.sms_enrollment_gate enable row level security;
alter table hag_private.sms_enrollment_gate force row level security;
revoke all on hag_private.sms_enrollment_gate from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control,hag_sms_intake,hag_sms_inbound,hag_sms_receipts,hag_sms_dispatch;
-- Serialize gate reads with operator changes; no activation function is provided.
create function hag_private.sms_intake_stage(p_id uuid,p_name text,p_adult boolean,p_dest text,p_sports text[],p_updates text[],p_consent boolean,p_version text,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare enabled_now boolean;
begin
 select enabled into enabled_now from hag_private.sms_enrollment_gate where singleton for share;
 if enabled_now is distinct from true then return false;end if;
 return hag_private.sms_stage_join(p_id,p_name,p_adult,p_dest,p_sports,p_updates,p_consent,p_version,p_hash);
end$$;
create function hag_private.sms_inbound_event(p_sid text,p_dest text,p_kind text,p_code text,p_review text)
returns boolean language plpgsql security definer set search_path='' as $$
declare enabled_now boolean;
begin
 if p_kind='join' then
  select enabled into enabled_now from hag_private.sms_enrollment_gate where singleton for share;
  if enabled_now is distinct from true then return true;end if;
 end if;
 -- STOP and manual review remain independent from signup and delivery gates.
 return hag_private.sms_record_inbound(p_sid,p_dest,p_kind,p_code,p_review);
end$$;
revoke all on function hag_private.sms_intake_stage(uuid,text,boolean,text,text[],text[],boolean,text,text),hag_private.sms_inbound_event(text,text,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
grant usage on schema hag_private to hag_sms_intake,hag_sms_inbound,hag_sms_receipts,hag_sms_dispatch;
grant execute on function hag_private.sms_intake_stage(uuid,text,boolean,text,text[],text[],boolean,text,text) to hag_sms_intake;
grant execute on function hag_private.sms_inbound_event(text,text,text,text,text) to hag_sms_inbound;
grant execute on function hag_private.sms_record_delivery(text,text,text,text) to hag_sms_receipts;
grant execute on function hag_private.sms_ack_claim(),hag_private.sms_ack_start(uuid),hag_private.sms_ack_finish(uuid,text,text) to hag_sms_dispatch;
-- Keep the raw consent functions and direct quota reservation inaccessible.
-- No role membership or login credentials are added. No tables are granted.
commit;
