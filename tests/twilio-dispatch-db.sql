begin;
do $qa$
declare dest text:='+12025550123'; code text:=repeat('a',24); h text:=encode(extensions.digest(repeat('a',24),'sha256'),'hex'); j jsonb; t uuid; m uuid;
begin
 if has_function_privilege('anon','hag_private.sms_ack_claim()','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.sms_ack_claim()','execute') then raise exception 'SMS dispatch grant leak';end if;
 if hag_private.sms_ack_claim() is not null then raise exception 'disabled claim';end if;
 if not hag_private.sms_stage_join(gen_random_uuid(),'Fixture',true,dest,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'stage';end if;
 if not hag_private.sms_record_inbound('SM'||repeat('1',32),dest,'join',code) then raise exception 'join';end if;
 update hag_private.sms_release_gate set enabled=true;
 j:=hag_private.sms_ack_claim();t:=(j->>'ticket')::uuid;
 if t is null or j->>'destination'<>dest then raise exception 'claim';end if;
 if hag_private.sms_ack_finish(t,'accepted','SM'||repeat('2',32)) then raise exception 'unstarted acceptance';end if;
 if not hag_private.sms_ack_start(t) or hag_private.sms_ack_start(t) then raise exception 'start replay';end if;
 if not hag_private.sms_ack_finish(t,'provider-blocked',null) or hag_private.sms_ack_finish(t,'accepted','SM'||repeat('2',32)) then raise exception 'finish replay';end if;
 select id into m from hag_private.hag_contact_methods where destination=dest;
 if not exists(select 1 from hag_private.sms_provider_blocks where destination=dest) or not exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then raise exception 'provider block not reflected';end if;
end $qa$;
rollback;
select 'PASS: SMS acknowledgment reservation, one-time start, provider block suppression and closed runtime grants' as result;
