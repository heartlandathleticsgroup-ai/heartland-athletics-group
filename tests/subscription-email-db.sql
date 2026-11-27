-- Disposable CI only, no hosted connection. No token values emitted.
do $qa$
declare d text:='email-readiness@example.invalid'; a text; u text; mid uuid; n int; c jsonb;
begin
 if has_function_privilege('anon','hag_private.subscription_email_delivery_eligible(text,text,text)','execute') or has_function_privilege('authenticated','hag_private.subscription_email_delivery_eligible(text,text,text)','execute') or has_function_privilege('hag_subscription_runtime','hag_private.subscription_metadata_cleanup()','execute') then raise exception 'grant leak';end if;
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 a:=hag_private.subscription_gateway_issue(gen_random_uuid(),'subscribe','Fixture',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1','confirm');
 u:=hag_private.subscription_gateway_issue(gen_random_uuid(),'access',null,null,'email',d,null,null,null,'unsubscribe');
 if not hag_private.subscription_email_delivery_eligible(a,d,'confirm') or hag_private.subscription_email_delivery_eligible(a,'other@example.invalid','confirm') or hag_private.subscription_email_delivery_eligible(a,d,'manage') then raise exception 'eligibility mismatch';end if;
 if not hag_private.subscription_email_delivery_eligible(u,d,'unsubscribe') then raise exception 'unsubscribe delivery denied';end if;
 perform hag_private.subscription_redeem(u,'unsubscribe');
 if hag_private.subscription_email_delivery_eligible(a,d,'confirm') or hag_private.subscription_email_delivery_eligible(u,d,'unsubscribe') then raise exception 'revoked/used delivery allowed';end if;
 execute 'reset role';
 select id into strict mid from hag_private.hag_contact_methods where destination=d;
 update hag_private.subscription_capabilities set expires_at=clock_timestamp()-interval '2 days' where method_id=mid;
 insert into hag_private.subscription_abuse values('cleanup-fixture','test',clock_timestamp()-interval '2 days',1);
 insert into hag_private.subscription_issue_keys(request_id,channel,created_at) values(gen_random_uuid(),'email',clock_timestamp()-interval '2 days');
 select count(*) into n from hag_private.hag_consent_events;
 execute 'set local role hag_subscription_maintenance';
 c:=hag_private.subscription_metadata_cleanup();
 if (c->>'capabilities')::int<2 or (c->>'abuse')::int<1 or (c->>'issue_keys')::int<1 then raise exception 'cleanup not effective';end if;
 execute 'reset role';
 if (select count(*) from hag_private.hag_consent_events)<>n or not exists(select 1 from hag_private.hag_suppressions where contact_method_id=mid and active) then raise exception 'consent or suppression lost';end if;
end $qa$;
select 'PASS: email capability eligibility, suppression, purpose/destination binding, restricted metadata cleanup preserving consent and suppressions' as result;
