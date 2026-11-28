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
