-- REVIEW ONLY; not applied to production. Administrator-assisted CAN-SPAM opt-out.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create function hag_private.manual_email_optout(p_destination text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare dest text:=lower(btrim(p_destination)); m uuid;
begin
 if hag_private.admin_session_state() is distinct from 'authorized' then raise exception 'Access unavailable';end if;
 if not coalesce(hag_private.subscription_destination_valid('email',dest),false) then return jsonb_build_object('ok',false);end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||dest,0));
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=dest for update;
 if m is null then return jsonb_build_object('ok',true,'matched',false);end if;
 insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
 select id,'withdrawn','hag-sports-v1','Administrator recorded a requested channel-wide email opt-out.','manual_revocation','email'
 from hag_private.hag_subscriptions where contact_method_id=m and status in ('active','pending');
 update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('active','pending');
 -- Existing suppression trigger withdraws sport preferences; dispatch rechecks the suppression.
 insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'manual',true)
 on conflict(contact_method_id,reason) do update set active=true;
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
 return jsonb_build_object('ok',true,'matched',true);
end$$;
create function public.hag_manual_email_optout(p_destination text)
returns jsonb language sql security invoker set search_path='' as $$select hag_private.manual_email_optout(p_destination)$$;
revoke all on function hag_private.manual_email_optout(text),public.hag_manual_email_optout(text) from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime;
grant execute on function hag_private.manual_email_optout(text),public.hag_manual_email_optout(text) to authenticated;
commit;
