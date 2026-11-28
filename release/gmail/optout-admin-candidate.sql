-- Review-only: reuse existing fresh administrator proof. No new provider grants.
begin;
create function hag_private.manual_sms_optout(p_destination text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d text:=btrim(p_destination); m uuid;
begin
 if hag_private.gmail_admin_proof() is null then raise exception 'Access unavailable';end if;
 if d is null or d !~ '^[+]1[2-9][0-9]{9}$' then return jsonb_build_object('ok',false);end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||d,0));
 insert into hag_private.sms_provider_blocks(destination) values(d) on conflict(destination) do update set blocked_at=clock_timestamp(),provider_unblocked_at=null;
 delete from hag_private.sms_join_pending where destination=d;
 select id into m from hag_private.hag_contact_methods where channel='sms' and destination=d;
 if m is not null then
  insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
  select id,'withdrawn','hag-sports-v1','Administrator recorded an SMS opt-out.','manual_revocation','sms' from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active');
  update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('pending','active');
  insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'manual',true) on conflict(contact_method_id,reason) do update set active=true;
  update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
  update hag_private.sms_confirmation_outbox set state='cancelled',finished_at=clock_timestamp() where method_id=m and state='queued';
 end if;
 return jsonb_build_object('ok',true);
end$$;
revoke all on function hag_private.manual_sms_optout(text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_control,hag_gmail_dispatch;
create or replace function hag_private.sport_admin(p_action text,p_code text default null,p_label text default null,p_active boolean default null,p_update text default null,p_channel text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 if hag_private.gmail_admin_proof() is null then raise exception 'Access unavailable';end if;
 if p_action='optout-email' then return hag_private.manual_email_optout(p_code);end if;
 if p_action='optout-sms' then return hag_private.manual_sms_optout(p_code);end if;
 if p_action='sms-review-list' then
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at,r.message_sid) from
   (select q.message_sid,e.destination,q.reply_text,q.created_at from hag_private.sms_review_queue q join hag_private.sms_provider_events e using(message_sid) where q.resolved_at is null order by q.created_at,q.message_sid limit 50) r),'[]'::jsonb);
 end if;
 if p_action='sms-review-close' then
  update hag_private.sms_review_queue set resolved_at=clock_timestamp(),reply_text='' where message_sid=p_code and resolved_at is null;
  return jsonb_build_object('ok',found);
 end if;
 if p_action='catalog' then return coalesce((select jsonb_agg(jsonb_build_object('code',code,'label',label,'active',active) order by label) from hag_private.sport_catalog),'[]'::jsonb);end if;
 if p_action='save' then
  if p_code is null or p_code !~ '^[a-z][a-z0-9-]{0,39}$' or p_code='all-sports' or p_label is null or length(btrim(p_label)) not between 1 and 80 or p_label ~ '[[:cntrl:]]' or p_active is null then raise exception 'Invalid sport';end if;
  if not exists(select 1 from hag_private.sport_catalog where code=p_code) and (select count(*) from hag_private.sport_catalog)>=40 then raise exception 'Catalog limit';end if;
  insert into hag_private.sport_catalog(code,label,active) values(p_code,btrim(p_label),p_active) on conflict(code) do update set label=excluded.label,active=excluded.active;
  return jsonb_build_object('ok',true);
 end if;
 if p_action='count' then
  if not hag_private.sport_target_valid(p_code,p_update,p_channel) then raise exception 'Invalid audience';end if;
  return jsonb_build_object('count',(select count(*) from hag_private.sport_audience(p_code,p_update,p_channel)));
 end if;
 raise exception 'Invalid action';
end$$;
commit;
