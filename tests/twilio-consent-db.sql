begin;
do $qa$
declare dest text:='+12025550123'; other text:='+12025550124'; code text:=repeat('a',24); h text:=encode(extensions.digest(repeat('a',24),'sha256'),'hex'); m uuid; k text;
begin
 if has_function_privilege('anon','hag_private.sms_record_inbound(text,text,text,text,text)','execute') or has_function_privilege('authenticated','hag_private.sms_stage_join(uuid,text,boolean,text,text[],text[],boolean,text,text)','execute') or has_function_privilege('hag_subscription_runtime','hag_private.sms_stage_join(uuid,text,boolean,text,text[],text[],boolean,text,text)','execute') then raise exception 'SMS grants leaked';end if;
 if hag_private.sms_stage_join(gen_random_uuid(),'Fixture',false,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'minor signup';end if;
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'pending signup';end if;
 if exists(select 1 from hag_private.hag_contact_methods where destination=dest) then raise exception 'premature contact';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('1',32),other,'join',code) or exists(select 1 from hag_private.hag_contact_methods where destination=dest) then raise exception 'wrong phone confirmed';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('2',32),dest,'join',repeat('b',24)) or exists(select 1 from hag_private.hag_contact_methods where destination=dest) then raise exception 'wrong code confirmed';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('3',32),dest,'join',code) then raise exception 'valid confirmation';end if;
 select id into m from hag_private.hag_contact_methods where channel='sms' and destination=dest and verified_at is not null;
 if m is null or not exists(select 1 from hag_private.sms_confirmation_outbox where method_id=m and state='queued') or not exists(select 1 from hag_private.sport_preferences where method_id=m and channel='sms' and status='active') then raise exception 'confirmed SMS missing';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('3',32),dest,'join',code) then raise exception 'replay failed';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('4',32),dest,'stop',null) then raise exception 'stop failed';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('5',32),dest,'start',null) then raise exception 'start failed';end if;
 if not exists(select 1 from hag_private.sms_confirmation_outbox where method_id=m and state='cancelled') or not exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active and reason='stop') or exists(select 1 from hag_private.sport_preferences where method_id=m and status<>'withdrawn') then raise exception 'start restored local consent';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('6',32),other,'stop',null) or hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,other,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'unknown phone suppression failed';end if;
if not hag_private.sms_record_inbound('SM'||repeat('7',32),other,'review',null,'please do not text me') then raise exception 'freeform reply rejected';end if;
 if not exists(select 1 from hag_private.sms_review_queue where reply_text='please do not text me' and resolved_at is null) then raise exception 'freeform optout review missing';end if;
end $qa$;
rollback;
select 'PASS: signed-adapter-only candidate, pending JOIN, phone/code binding, confirmation, STOP, START does not restore and unknown-number suppression' as result;
