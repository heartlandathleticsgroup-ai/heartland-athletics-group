-- Apply only after policy and runtime approval. No Google credentials or sending.
begin;
create function hag_private.subscription_public_email_signup_v1(p_id uuid,p_name text,p_destination text,p_topics text[],p_notice text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_notice is distinct from 'hag-subscriber-notice-v1' or p_id is null or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or not hag_private.subscription_destination_valid('email',p_destination) or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return false;end if;
 -- The fixed notice maps to the existing exact consent wording and immutable internal version.
 -- Shared ingress limits deliberately avoid trusting caller-controlled forwarded IP headers.
 perform pg_advisory_xact_lock(hashtextextended('hag-email-public-admission-v1',0));
 if not hag_private.subscription_allow('public-signup-hour','all',60,100) then return false;end if;
 if (select count(*) from hag_private.hag_contact_methods where channel='email')>=5000 or (select count(*) from hag_private.subscription_issue_keys)>=20000 or (select count(*) from hag_private.subscription_abuse)>=30000 then return false;end if;
 perform hag_private.subscription_email_opt_in(p_id,p_name,true,p_destination,p_topics,true,'draft-3c3-v1');
 return true;
end $$;
revoke all on function hag_private.subscription_public_email_signup_v1(uuid,text,text,text[],text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_public_email_signup_v1(uuid,text,text,text[],text) to hag_subscription_runtime;
-- Manual revocation received via email, phone or another reasonable method.
-- The admin records a real request; this is not a permission to enroll anyone.
create function hag_private.subscription_manual_revoke_v1(p_channel text,p_destination text) returns boolean language plpgsql security definer set search_path='' as $$
declare m uuid; s record;
begin
 if auth.uid() is null or hag_private.admin_session_state() is distinct from 'authorized' then raise exception 'Administrative access required' using errcode='42501';end if;
 if p_channel not in ('email','sms') or p_destination is null or not hag_private.subscription_destination_valid(p_channel,p_destination) then raise exception 'Invalid contact method';end if;
 perform pg_advisory_xact_lock(hashtextextended('hag-subscription:'||p_channel||':'||p_destination,0));
 select id into m from hag_private.hag_contact_methods where channel=p_channel and destination=p_destination;
 if m is null then return false;end if;
 for s in select id from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active') loop
  insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
  values(s.id,'withdrawn','hag-manual-revoke-v1','Recipient requested withdrawal of all marketing for this channel.','manual_revocation',p_channel);
  update hag_private.hag_subscriptions set status='withdrawn' where id=s.id;
 end loop;
 insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'unsubscribe',true) on conflict(contact_method_id,reason) do update set active=true;
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=m and used_at is null and purpose<>'unsubscribe';
 return true;
end $$;
revoke all on function hag_private.subscription_manual_revoke_v1(text,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.subscription_manual_revoke_v1(text,text) to authenticated;
create function public.hag_subscription_manual_revoke_v1(p_channel text,p_destination text) returns boolean language sql security invoker set search_path='' as $$ select hag_private.subscription_manual_revoke_v1(p_channel,p_destination) $$;
revoke all on function public.hag_subscription_manual_revoke_v1(text,text) from public,anon,authenticated,service_role;
grant execute on function public.hag_subscription_manual_revoke_v1(text,text) to authenticated;
commit;
