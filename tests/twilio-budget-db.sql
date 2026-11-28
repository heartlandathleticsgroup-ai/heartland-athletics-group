begin;
do $qa$
declare dest text:='+12025550123'; code text:=repeat('a',24); h text:=encode(extensions.digest(repeat('a',24),'sha256'),'hex'); j jsonb; t uuid;
begin
 if has_function_privilege('anon','hag_private.sms_reserve_ack_segments(uuid)','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.sms_reserve_ack_segments(uuid)','execute') then raise exception 'budget grant leak';end if;
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) or not hag_private.sms_record_inbound('SM'||repeat('1',32),dest,'join',code) then raise exception 'fixture';end if;
 update hag_private.sms_release_gate set enabled=true;
 j:=hag_private.sms_ack_claim();t:=(j->>'ticket')::uuid;
 if t is null then raise exception 'claim';end if;
 -- Evaluate volatile calls in separate statements before reading their effects.
 if hag_private.sms_ack_start(t) then raise exception 'zero budget allowed start';end if;
 if exists(select 1 from hag_private.sms_budget_reservations) then raise exception 'zero budget reserved segments';end if;
 if not exists(select 1 from hag_private.sms_confirmation_outbox where ticket=t and state='held') then raise exception 'zero budget did not hold attempt';end if;
end $qa$;
rollback;
begin;
do $qa$
declare dest text:='+12025550123'; code text:=repeat('b',24); h text:=encode(extensions.digest(repeat('b',24),'sha256'),'hex'); j jsonb; t uuid; second_ticket uuid:=gen_random_uuid(); m uuid;
begin
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) or not hag_private.sms_record_inbound('SM'||repeat('2',32),dest,'join',code) then raise exception 'fixture';end if;
 update hag_private.sms_release_gate set enabled=true;
 update hag_private.sms_budget_limits set daily_segments=2,monthly_segments=2;
 j:=hag_private.sms_ack_claim();t:=(j->>'ticket')::uuid;
 if t is null then raise exception 'claim failed';end if;
 if not hag_private.sms_ack_start(t) then raise exception 'approved reservation failed';end if;
 if hag_private.sms_ack_start(t) then raise exception 'duplicate start allowed';end if;
 if (select coalesce(sum(segments),0) from hag_private.sms_budget_reservations)<>2 then raise exception 'one reservation failed';end if;
 if not hag_private.sms_ack_finish(t,'held',null) then raise exception 'finish failed';end if;
 if (select coalesce(sum(segments),0) from hag_private.sms_budget_reservations)<>2 then raise exception 'ambiguous attempt refunded';end if;
 dest:='+12025550124';code:=repeat('c',24);h:=encode(extensions.digest(code,'sha256'),'hex');
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture Two',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) or not hag_private.sms_record_inbound('SM'||repeat('3',32),dest,'join',code) then raise exception 'second fixture';end if;
 select id into m from hag_private.hag_contact_methods where destination=dest;
 -- Simulate the next claim without waiting a minute; start fence still runs.
 update hag_private.sms_confirmation_outbox set state='reserved',ticket=second_ticket,reserved_at=clock_timestamp() where method_id=m;
 if hag_private.sms_ack_start(second_ticket) then raise exception 'exhausted budget allowed start';end if;
 if (select coalesce(sum(segments),0) from hag_private.sms_budget_reservations)<>2 then raise exception 'budget exceeded';end if;
 if not exists(select 1 from hag_private.sms_confirmation_outbox where ticket=second_ticket and state='held') then raise exception 'exhausted budget did not hold attempt';end if;
end $qa$;
rollback;
select 'PASS: zero-default segment cap, one-time reservation, no refund and budget exhaustion' as result;
