begin;
do $qa$
declare r text; d text:='+12025550123'; c text:=repeat('a',24); h text:=encode(extensions.digest(repeat('a',24),'sha256'),'hex');
begin
 foreach r in array array['hag_sms_intake','hag_sms_inbound','hag_sms_receipts','hag_sms_dispatch'] loop
  if not exists(select 1 from pg_roles where rolname=r and not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolreplication) then raise exception 'unsafe SMS role';end if;
  if exists(select 1 from pg_auth_members m join pg_roles p on p.oid=m.roleid where p.rolname=r) then raise exception 'SMS role membership';end if;
  if has_table_privilege(r,'hag_private.sms_enrollment_gate','UPDATE') or has_table_privilege(r,'hag_private.sms_release_gate','UPDATE') or has_table_privilege(r,'hag_private.sms_budget_limits','UPDATE') or has_table_privilege(r,'hag_private.sms_review_queue','SELECT') or has_function_privilege(r,'hag_private.sms_record_inbound(text,text,text,text,text)','EXECUTE') or has_function_privilege(r,'hag_private.sms_reserve_ack_segments(uuid)','EXECUTE') or has_function_privilege(r,'hag_private.sms_stage_join(uuid,text,boolean,text,text[],text[],boolean,text,text)','EXECUTE') then raise exception 'SMS privilege leak: %',r;end if;
  if has_function_privilege(r,'hag_private.sms_intake_stage(uuid,text,boolean,text,text[],text[],boolean,text,text)','EXECUTE') is distinct from (r='hag_sms_intake') or has_function_privilege(r,'hag_private.sms_inbound_event(text,text,text,text,text)','EXECUTE') is distinct from (r='hag_sms_inbound') or has_function_privilege(r,'hag_private.sms_record_delivery(text,text,text,text)','EXECUTE') is distinct from (r='hag_sms_receipts') or has_function_privilege(r,'hag_private.sms_ack_claim()','EXECUTE') is distinct from (r='hag_sms_dispatch') or has_function_privilege(r,'hag_private.sms_ack_start(uuid)','EXECUTE') is distinct from (r='hag_sms_dispatch') or has_function_privilege(r,'hag_private.sms_ack_finish(uuid,text,text)','EXECUTE') is distinct from (r='hag_sms_dispatch') then raise exception 'SMS role separation: %',r;end if;
 end loop;
 if has_function_privilege('anon','hag_private.sms_intake_stage(uuid,text,boolean,text,text[],text[],boolean,text,text)','EXECUTE') or has_function_privilege('authenticated','hag_private.sms_inbound_event(text,text,text,text,text)','EXECUTE') then raise exception 'browser grant';end if;
 if hag_private.sms_intake_stage(gen_random_uuid(),'Fixture',true,d,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'closed intake';end if;
 -- Simulate a pending signup created before an emergency pause.
 update hag_private.sms_enrollment_gate set enabled=true;
 if not hag_private.sms_intake_stage(gen_random_uuid(),'Fixture',true,d,array['basketball'],array['general'],true,'hag-sports-v1',h) then raise exception 'open fixture intake';end if;
 update hag_private.sms_enrollment_gate set enabled=false;
 if not hag_private.sms_inbound_event('SM'||repeat('1',32),d,'join',c,null) then raise exception 'disabled JOIN response';end if;
 if exists(select 1 from hag_private.hag_contact_methods where destination=d) then raise exception 'closed JOIN activated';end if;
 if not hag_private.sms_inbound_event('SM'||repeat('2',32),d,'stop',null,null) then raise exception 'STOP failed while paused';end if;
 if exists(select 1 from hag_private.sms_join_pending where destination=d) or not exists(select 1 from hag_private.sms_provider_blocks where destination=d) then raise exception 'paused suppression failed';end if;
 if hag_private.sms_ack_claim() is not null then raise exception 'dispatch unexpectedly enabled';end if;
end $qa$;
rollback;
select 'PASS: four NOLOGIN roles, separate default-off gates, no public grants, opt-out during pause' as result;
