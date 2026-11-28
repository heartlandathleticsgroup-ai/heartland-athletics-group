-- Review-only incremental candidate, after twilio-consent and twilio-dispatch.
-- No runtime grants, provider calls, production changes, or automatic dispatch.
begin;
create table hag_private.sms_delivery_state(
 provider_sid text primary key references hag_private.sms_confirmation_outbox(provider_sid),
 status text not null check(status in ('accepted','queued','sending','sent','delivered','undelivered','failed','canceled')),
 review_required boolean not null default false,
 updated_at timestamptz not null default clock_timestamp()
);
create table hag_private.sms_delivery_receipts(
 provider_sid text not null references hag_private.sms_delivery_state(provider_sid),
 status text not null check(status in ('accepted','queued','sending','sent','delivered','undelivered','failed','canceled')),
 error_code text not null default '' check(error_code ~ '^([0-9]{1,8})?$'),
 received_at timestamptz not null default clock_timestamp(),
 primary key(provider_sid,status,error_code)
);
alter table hag_private.sms_delivery_state enable row level security;
alter table hag_private.sms_delivery_state force row level security;
alter table hag_private.sms_delivery_receipts enable row level security;
alter table hag_private.sms_delivery_receipts force row level security;
revoke all on hag_private.sms_delivery_state,hag_private.sms_delivery_receipts from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
create function hag_private.sms_record_delivery(p_sid text,p_dest text,p_status text,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
declare m uuid; old_status text; old_rank integer; new_rank integer;
begin
 if p_sid is null or p_sid !~ '^SM[0-9A-Fa-f]{32}$' or p_dest is null or p_dest !~ '^[+]1[2-9][0-9]{9}$' or p_status is null or p_status not in ('accepted','queued','sending','sent','delivered','undelivered','failed','canceled') or (p_error is not null and p_error !~ '^[0-9]{1,8}$') then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||p_dest,0));
 select q.method_id into m from hag_private.sms_confirmation_outbox q join hag_private.hag_contact_methods c on c.id=q.method_id where q.provider_sid=p_sid and q.state='accepted' and c.channel='sms' and c.destination=p_dest for update of q;
 -- Unknown or early receipt is NOT attributed to a subscriber. Adapter returns 503;
 -- production must reconcile early/lost callbacks against the provider API before release.
 if m is null then return false;end if;
 insert into hag_private.sms_delivery_state(provider_sid,status) values(p_sid,'accepted') on conflict do nothing;
 select status into old_status from hag_private.sms_delivery_state where provider_sid=p_sid for update;
 insert into hag_private.sms_delivery_receipts(provider_sid,status,error_code) values(p_sid,p_status,coalesce(p_error,'')) on conflict do nothing;
 if not found then return true;end if;
 old_rank:=case old_status when 'accepted' then 0 when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 else 4 end;
 new_rank:=case p_status when 'accepted' then 0 when 'queued' then 1 when 'sending' then 2 when 'sent' then 3 else 4 end;
 update hag_private.sms_delivery_state set status=case when new_rank>old_rank then p_status else old_status end,
 review_required=review_required or (old_rank=4 and new_rank=4 and old_status<>p_status) or p_error='21610' is true,
 updated_at=clock_timestamp() where provider_sid=p_sid;
 -- Explicit provider opt-out error must suppress even if delivery statuses conflict.
 if p_error='21610' then
  insert into hag_private.sms_provider_blocks(destination) values(p_dest) on conflict(destination) do update set blocked_at=clock_timestamp(),provider_unblocked_at=null;
  delete from hag_private.sms_join_pending where destination=p_dest;
  insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
   select id,'withdrawn','hag-sports-v1','Provider status reported blocked SMS destination.','provider_stop','sms' from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active');
  update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('pending','active');
  insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'stop',true) on conflict(contact_method_id,reason) do update set active=true;
  update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
 end if;
 return true;
end$$;
revoke all on function hag_private.sms_record_delivery(text,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
commit;
