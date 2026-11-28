-- No external delivery or hosted credentials; reserved example.com address.
begin;
do $qa$
declare d text:='release-test@example.com'; m uuid; k text:=repeat('a',64); g bigint; j jsonb; v jsonb;
begin
 if exists(select 1 from hag_private.gmail_connection where enabled or credential is not null) then raise exception 'unsafe initial state';end if;
 if to_regprocedure('hag_private.gmail_enable_fixture(bigint)') is not null or to_regprocedure('hag_private.subscription_email_sim_step(uuid,uuid,text,text,text)') is not null then raise exception 'simulation bypass';end if;
 if has_function_privilege('hag_subscription_runtime','hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text)','execute') then raise exception 'SMS fixture exposed';end if;
 if not hag_private.subscription_destination_valid('email',d) or hag_private.subscription_destination_valid('email','x,y@example.com') or hag_private.subscription_destination_valid('email','a..b@example.com') then raise exception 'email validation';end if;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_email_opt_in(gen_random_uuid(),'Fixture',true,d,array['hag-announcements'],true,'draft-3c3-v1');
 execute 'reset role';
 select id into strict m from hag_private.hag_contact_methods where destination=d;
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m and status='active' and email_opt_in_event_id is not null and confirmation_event_id is null) or not exists(select 1 from hag_private.hag_contact_methods where id=m and verified_at is null) or exists(select 1 from hag_private.subscription_email_outbox) then raise exception 'signup evidence or send leak';end if;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'access',null,null,d,null,null,null,'manage',k,'fixture');
 execute 'reset role';
 if (select count(*) from hag_private.subscription_email_outbox)<>1 then raise exception 'real-shaped access enqueue';end if;
 execute 'set local role hag_gmail_dispatch';
 if hag_private.gmail_claim() is not null then raise exception 'disabled dispatch';end if;
 execute 'reset role';
 execute 'set local role hag_gmail_control';
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 if not hag_private.gmail_store(g,'encrypted-fixture','fixture') then raise exception 'store';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 execute 'reset role';
 execute 'set local role hag_gmail_release_operator';
 if not hag_private.gmail_enable_reviewed(g) then raise exception 'isolated approval';end if;
 execute 'reset role';
 execute 'set local role hag_gmail_dispatch';
 j:=hag_private.gmail_claim();v:=hag_private.gmail_reserve((j->>'id')::uuid,(j->>'lease')::uuid,k,'fixture');
 if v is null or v->'message'->>'destination'<>d then raise exception 'real-shaped reserve';end if;
 if not hag_private.gmail_dispatch_allowed((v->>'ticket')::uuid,g,d,'manage',v->'message'->>'token') then raise exception 'dispatch fence';end if;
 if not hag_private.gmail_finish((v->>'ticket')::uuid,'ambiguous-hold-no-resend') or hag_private.gmail_claim() is not null then raise exception 'retry leak';end if;
 execute 'reset role';
end $qa$;
select 'PASS: consolidated real-recipient consent, no signup message, disabled worker, separate activation role, access-only dispatch and no resend' as result;
rollback;
