begin;
do $qa$
declare r jsonb; d text:='+12025550123';
begin
 if has_function_privilege('anon','public.hag_sport_admin(text,text,text,boolean,text,text)','execute') or has_function_privilege('authenticated','hag_private.manual_sms_optout(text)','execute') then raise exception 'grant leak';end if;
 begin perform public.hag_sport_admin('sms-review-list');raise exception 'unauthorized list';exception when raise_exception then if sqlerrm<>'Access unavailable' then raise;end if;end;
 if not hag_private.sms_record_inbound('SM'||repeat('1',32),d,'review',null,'Please remove me') then raise exception 'review fixture';end if;
 perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
 perform set_config('request.jwt.claims','{"session_id":"00000000-0000-4000-8000-000000000002","aal":"aal2"}',true);
 perform set_config('hag.fixture.gate','authorized',true);
 execute 'set local role authenticated';
 r:=public.hag_sport_admin('sms-review-list');if jsonb_array_length(r)<>1 or r->0->>'reply_text'<>'Please remove me' then raise exception 'review list';end if;
 r:=public.hag_sport_admin('sms-review-close','SM'||repeat('1',32));if r->>'ok'<>'true' then raise exception 'review close';end if;
 r:=public.hag_sport_admin('optout-sms','+12025550124');if r->>'ok'<>'true' then raise exception 'manual SMS optout';end if;
 execute 'reset role';
 if exists(select 1 from hag_private.sms_review_queue where resolved_at is null or reply_text<>'') or (select count(*) from hag_private.sms_provider_blocks)<>2 then raise exception 'review restored consent or retained text';end if;
end $qa$;
rollback;
select 'PASS: authenticated opt-out administration, bounded reply review, no re-enrollment, closed text removed' as result;
