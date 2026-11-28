begin;
do $qa$
declare dest text:='+12025550123'; code text:=repeat('a',24); h text:=encode(extensions.digest(repeat('a',24),'sha256'),'hex'); j jsonb; t uuid; m uuid; sid text:='SM'||repeat('9',32);
begin
 if has_function_privilege('anon','hag_private.sms_record_delivery(text,text,text,text)','execute') or has_function_privilege('authenticated','hag_private.sms_record_delivery(text,text,text,text)','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.sms_record_delivery(text,text,text,text)','execute') then raise exception 'status grant leak';end if;
 if hag_private.sms_record_delivery(sid,dest,'delivered',null) then raise exception 'unknown receipt accepted';end if;
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'stage';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('8',32),dest,'join',code) then raise exception 'join';end if;
 update hag_private.sms_release_gate set enabled=true;
 j:=hag_private.sms_ack_claim();t:=(j->>'ticket')::uuid;
 if t is null or not hag_private.sms_ack_start(t) or not hag_private.sms_ack_finish(t,'accepted',sid) then raise exception 'accept fixture';end if;
 if hag_private.sms_record_delivery(sid,'+12025550124','delivered',null) then raise exception 'wrong recipient accepted';end if;
 if not hag_private.sms_record_delivery(sid,dest,'delivered',null) or not hag_private.sms_record_delivery(sid,dest,'delivered',null) or not hag_private.sms_record_delivery(sid,dest,'sent',null) then raise exception 'receipt failure';end if;
 if (select count(*) from hag_private.sms_delivery_receipts where provider_sid=sid)<>2 or not exists(select 1 from hag_private.sms_delivery_state where provider_sid=sid and status='delivered' and not review_required) then raise exception 'duplicate or backwards transition';end if;
 if not hag_private.sms_record_delivery(sid,dest,'undelivered','21610') then raise exception 'block receipt failure';end if;
 select id into m from hag_private.hag_contact_methods where channel='sms' and destination=dest;
 if not exists(select 1 from hag_private.sms_delivery_state where provider_sid=sid and status='delivered' and review_required) or not exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active and reason='stop') or not exists(select 1 from hag_private.sport_preferences where method_id=m and status='withdrawn') then raise exception 'conflict or suppression lost';end if;
end $qa$;
rollback;
select 'PASS: private callback status ledger, SID/destination binding, duplicate and late receipts, terminal conflict and suppression' as result;
