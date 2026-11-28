-- Load after pending, confirmation and gateway drafts in one rolled-back transaction.
do $qa$
declare d text:='gateway-'||gen_random_uuid()||'@example.invalid'; rid uuid:=gen_random_uuid(); a text; m uuid; i int;
begin
 if has_function_privilege('anon','hag_private.subscription_gateway_budget(text,text)','execute') or has_function_privilege('authenticated','hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text)','execute') or has_function_privilege('service_role','hag_private.subscription_request(text,boolean,text,text,text[],boolean,text)','execute') or has_table_privilege('service_role','hag_private.subscription_issue_keys','insert') then raise exception 'gateway grants';end if;
 execute 'set local role service_role';
 if not hag_private.subscription_gateway_budget('192.0.2.1','subscribe') then raise exception 'budget denied';end if;
 a:=hag_private.subscription_gateway_issue(rid,'subscribe','Fixture',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1','confirm');
 if a is null then raise exception 'issue failed';end if;
 if hag_private.subscription_gateway_issue(rid,'subscribe','Fixture',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1','confirm') is not null then raise exception 'duplicate issue';end if;
 if hag_private.subscription_gateway_issue(rid,'subscribe','Fixture',true,'email',d,array['volunteer-updates'],true,'draft-3c3-v1','confirm') is not null then raise exception 'changed body reused key';end if;
 if hag_private.subscription_redeem(a,'confirm') is null or hag_private.subscription_redeem(a,'confirm') is not null then raise exception 'confirm/replay';end if;
 if hag_private.subscription_gateway_issue(rid,'subscribe','Fixture',true,'sms','+12025550124',array['gus-macker-local'],true,'draft-3c3-v1','confirm') is null then raise exception 'channel key not independent';end if;
 execute 'reset role';
 select id into strict m from hag_private.hag_contact_methods where destination=d;
 if (select count(*) from hag_private.hag_subscriptions where contact_method_id=m)<>1 then raise exception 'duplicate write';end if;
 if (select count(*) from hag_private.hag_consent_events e join hag_private.hag_subscriptions s on s.id=e.subscription_id where s.contact_method_id=m)<>2 then raise exception 'duplicate event';end if;
 if (select count(*) from hag_private.subscription_issue_keys where request_id=rid)<>2 then raise exception 'key count';end if;
 -- Seed current window to avoid a test depending on elapsed wall clock.
 insert into hag_private.subscription_abuse(scope,bucket,window_start,hits)
 select 'gateway-source',encode(extensions.hmac(convert_to('192.0.2.1','UTF8'),secret,'sha256'),'hex'),date_trunc('minute',clock_timestamp()),20 from hag_private.subscription_rate_key
 on conflict(scope,bucket,window_start) do update set hits=20;
 execute 'set local role service_role';
 if hag_private.subscription_gateway_budget('192.0.2.1','access') then raise exception 'source limit bypass';end if;
 if not hag_private.subscription_gateway_budget('192.0.2.1','unsubscribe') then raise exception 'ordinary limit blocked optout';end if;
 execute 'reset role';
end $qa$;
select 'PASS: private gateway grants, idempotency, changed-body reuse, independent channels, one-use confirmation, source budget and separate opt-out budget' as result;

-- Audit regression: scope lookup does not consume or widen the capability.
do $audit$
declare d text:='audit-'||gen_random_uuid()||'@example.invalid'; a text; b text; m text; j jsonb; mid uuid;
begin
 delete from hag_private.subscription_abuse;
 if has_function_privilege('anon','hag_private.subscription_confirm_scope(text)','execute') or has_function_privilege('authenticated','hag_private.subscription_confirm_scope(text)','execute') then raise exception 'scope grant leak';end if;
 execute 'set local role service_role';
 a:=hag_private.subscription_gateway_issue(gen_random_uuid(),'subscribe','Fixture',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1','confirm');
 b:=hag_private.subscription_gateway_issue(gen_random_uuid(),'subscribe','Fixture',true,'email',d,array['camps-clinics'],true,'draft-3c3-v1','confirm');
 j:=hag_private.subscription_confirm_scope(a);
 if j is distinct from '{"channel":"email","topics":["hag-announcements"]}'::jsonb then raise exception 'scope mismatch';end if;
 if hag_private.subscription_redeem(a,'confirm') is null or hag_private.subscription_confirm_scope(a) is not null then raise exception 'scope consumed/replayed';end if;
 m:=hag_private.subscription_gateway_issue(gen_random_uuid(),'access',null,null,'email',d,null,null,null,'manage');
 j:=hag_private.subscription_redeem(m,'manage');
 execute 'reset role';
 update hag_private.hag_topics set active=false where code='hag-announcements' and purpose='subscription';
 execute 'set local role service_role';
 if not hag_private.subscription_edit(j->>'edit_token',array[]::text[],array['hag-announcements'],false,false,'old-draft') then raise exception 'retired withdrawal denied';end if;
 if hag_private.subscription_confirm_scope(b) is null or hag_private.subscription_redeem(b,'confirm') is null then raise exception 'unrelated pending link invalidated';end if;
 execute 'reset role';
 update hag_private.hag_topics set active=true where code='hag-announcements' and purpose='subscription';
 select id into strict mid from hag_private.hag_contact_methods where destination=d;
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='hag-announcements' and status='withdrawn') then raise exception 'withdrawal not recorded';end if;
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='camps-clinics' and status='active') then raise exception 'unrelated pending not confirmed';end if;
 -- A second token pointing only at an already-active topic cannot report success.
 select hag_private.subscription_new_token(mid,'confirm',array(select id from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='camps-clinics')) into a;
 execute 'set local role service_role';
 if hag_private.subscription_redeem(a,'confirm') is not null then raise exception 'no-op confirmation reported success';end if;
 execute 'reset role';
end $audit$;
select 'PASS: scoped confirmation, retired topic withdrawal, independent pending link and no-op rejection' as result;
