begin;
do $qa$
declare g bigint; testid uuid:=gen_random_uuid(); v jsonb;
begin
 if has_table_privilege('hag_gmail_dispatch','hag_private.gmail_sender_test','select') or has_function_privilege('authenticated','hag_private.gmail_sender_test_approve(bigint,uuid,text)','execute') or has_function_privilege('hag_gmail_control','hag_private.gmail_sender_test_claim(uuid)','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.gmail_sender_test_approve(bigint,uuid,text)','execute') then raise exception 'test grants too broad';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 if not hag_private.gmail_store(g,'fixture-encrypted','fixture') then raise exception 'fixture store';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 if hag_private.gmail_sender_test_claim(testid) is not null then raise exception 'unapproved claim';end if;
 execute 'set local role hag_gmail_release_operator';
 if hag_private.gmail_sender_test_approve(g,testid,'other@example.com') or not hag_private.gmail_sender_test_approve(g,testid,'jhawkins@heartlandathleticsgroup.com') or hag_private.gmail_sender_test_approve(g,gen_random_uuid(),'jhawkins@heartlandathleticsgroup.com') then raise exception 'approval scope';end if;
 execute 'reset role';
 execute 'set local role hag_gmail_dispatch';
 v:=hag_private.gmail_sender_test_claim(testid);
 if v->>'recipient' is distinct from 'jhawkins@heartlandathleticsgroup.com' or hag_private.gmail_sender_test_claim(testid) is not null then raise exception 'claim scope or replay';end if;
 if not hag_private.gmail_sender_test_finish(testid,'accepted-not-delivered') or hag_private.gmail_sender_test_finish(testid,'provider-rejected') then raise exception 'finish replay';end if;
 execute 'reset role';
 if exists(select 1 from hag_private.gmail_connection where enabled) or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.hag_subscriptions) then raise exception 'test touched production-like delivery';end if;
end $qa$;
rollback;
select 'PASS: sender test approval restricted to release operator, single claim, no ordinary send enablement' as result;
