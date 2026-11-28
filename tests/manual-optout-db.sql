begin;
do $qa$
declare g bigint; m uuid; k text:=repeat('a',64); r jsonb;
begin
 if has_function_privilege('anon','public.hag_manual_email_optout(text)','execute') or has_function_privilege('hag_subscription_runtime','hag_private.manual_email_optout(text)','execute') then raise exception 'manual optout grant leak';end if;
 begin perform public.hag_manual_email_optout('fixture@example.com');raise exception 'unauthorized optout allowed';exception when raise_exception then if sqlerrm<>'Access unavailable' then raise;end if;end;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 if not hag_private.gmail_store(g,'fixture-encrypted','fixture') then raise exception 'fixture store';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 execute 'set local role hag_gmail_release_operator';
 if not hag_private.gmail_record_sender_review(g,'no-reply@heartlandathleticsgroup.com','fixture-review',true,true,true,true,true,true,true) or not hag_private.gmail_enable_reviewed(g) then raise exception 'fixture enable';end if;
 execute 'reset role';
 if not hag_private.sport_email_signup(gen_random_uuid(),'Fixture Optout',true,'fixture@example.com',array['basketball'],array['general'],true,'hag-sports-v1',k,'fixture') then raise exception 'fixture signup';end if;
 select id into m from hag_private.hag_contact_methods where destination='fixture@example.com';
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
 perform set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-8000-000000000002","aal":"aal2"}',true);
 perform set_config('hag.fixture.gate','authorized',true);
 execute 'set local role authenticated';
 r:=public.hag_manual_email_optout(' FIXTURE@example.com ');if r->>'matched'<>'true' then raise exception 'manual optout';end if;
 r:=public.hag_manual_email_optout('fixture@example.com');if r->>'matched'<>'true' then raise exception 'idempotent optout';end if;
 r:=public.hag_manual_email_optout('missing@example.com');if r->>'matched'<>'false' then raise exception 'unknown optout';end if;
 execute 'reset role';
 if not exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active and reason='manual') or exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m and status<>'withdrawn') or exists(select 1 from hag_private.sport_preferences where method_id=m and status<>'withdrawn') then raise exception 'manual optout not enforced';end if;
 if not exists(select 1 from hag_private.hag_consent_events e join hag_private.hag_subscriptions s on s.id=e.subscription_id where s.contact_method_id=m and e.source='manual_revocation') then raise exception 'manual consent evidence';end if;
 if exists(select 1 from hag_private.subscription_capabilities where method_id=m and purpose<>'unsubscribe' and used_at is null) then raise exception 'management capability not retired';end if;
end $qa$;
rollback;
select 'PASS: authorized manual email opt-out, audit record, sport withdrawal, suppression and idempotence' as result;
