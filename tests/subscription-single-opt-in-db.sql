-- Disposable test cluster only; no real contacts or delivery.
begin;
do $qa$
declare d text:='single-opt-in@example.invalid'; rid uuid:=gen_random_uuid(); k text:=repeat('a',64); m uuid; mid uuid; raw text; a jsonb; n int; before_tokens int; before_jobs int; sid uuid;
begin
 delete from hag_private.subscription_abuse;
 select count(*) into before_tokens from hag_private.subscription_capabilities;
 select count(*) into before_jobs from hag_private.subscription_email_outbox;
 if has_function_privilege('anon','hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text)','execute') or has_function_privilege('authenticated','hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text)','execute') or has_function_privilege('hag_email_worker','hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text)','execute') then raise exception 'grant leak';end if;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_email_opt_in(rid,'Fixture',true,d,array['hag-announcements'],true,'draft-3c3-v1');
 perform hag_private.subscription_email_opt_in(rid,'Fixture',true,d,array['camps-clinics'],true,'draft-3c3-v1');
 perform hag_private.subscription_email_opt_in(gen_random_uuid(),'Fixture',false,'minor@example.invalid',array['hag-announcements'],true,'draft-3c3-v1');
 perform hag_private.subscription_email_opt_in(gen_random_uuid(),'Fixture',true,'no-consent@example.invalid',array['hag-announcements'],false,'draft-3c3-v1');
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'subscribe','Fixture',true,'bypass@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture');
 execute 'reset role';
 select id into strict m from hag_private.hag_contact_methods where destination=d;
 if not exists(select 1 from hag_private.hag_contact_methods where id=m and verified_at is null) then raise exception 'fabricated verified ownership';end if;
 if (select count(*) from hag_private.hag_subscriptions where contact_method_id=m)<>1 or not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m and status='active' and email_opt_in_event_id is not null and confirmation_event_id is null) then raise exception 'single opt-in state wrong';end if;
 if (select count(*) from hag_private.subscription_capabilities)<>before_tokens or (select count(*) from hag_private.subscription_email_outbox)<>before_jobs then raise exception 'signup generated a message or capability';end if;
 if exists(select 1 from hag_private.hag_contact_methods where destination in ('minor@example.invalid','no-consent@example.invalid','bypass@example.invalid')) then raise exception 'invalid consent or bypass accepted';end if;
 if (select count(*) from hag_private.hag_consent_events e join hag_private.hag_subscriptions s on s.id=e.subscription_id where s.contact_method_id=m and e.event_kind='requested' and e.source='website')<>1 then raise exception 'consent history wrong';end if;
 -- Requested management still creates an encrypted job.
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'access',null,null,d,null,null,null,'manage',k,'fixture');
 execute 'reset role';
 if (select count(*) from hag_private.subscription_email_outbox)<>before_jobs+1 then raise exception 'requested access not queued';end if;
 -- Withdrawn/suppressed email cannot be reactivated by unauthenticated signup.
 select id into strict sid from hag_private.hag_subscriptions where contact_method_id=m;
 update hag_private.hag_subscriptions set status='withdrawn' where id=sid;
 insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'unsubscribe',true);
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_email_opt_in(gen_random_uuid(),'Fixture',true,d,array['hag-announcements','camps-clinics'],true,'draft-3c3-v1');
 raw:=hag_private.subscription_gateway_issue_sms(gen_random_uuid(),'subscribe','Fixture',true,'+12025550129',array['hag-announcements'],true,'draft-3c3-v1','confirm');
 execute 'reset role';
 if exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m and status<>'withdrawn') then raise exception 'suppression bypass';end if;
 select id into strict mid from hag_private.hag_contact_methods where destination='+12025550129' and channel='sms';
 if raw is null or not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and status='pending' and confirmation_event_id is null and email_opt_in_event_id is null) then raise exception 'SMS not pending';end if;
 execute 'set local role hag_subscription_runtime';
 if hag_private.subscription_redeem(raw,'confirm') is null then raise exception 'SMS confirmation failed';end if;
 execute 'reset role';
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and status='active' and confirmation_event_id is not null and email_opt_in_event_id is null) then raise exception 'SMS proof missing';end if;
end $qa$;
select 'PASS: active email consent without verified ownership, no signup token or job, requested access only, invalid consent and suppression denial, SMS verification' as result;
rollback;
