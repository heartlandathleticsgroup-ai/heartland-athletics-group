-- Synthetic fixtures and local disposable database only.
do $qa$
declare k text:=repeat('a',64); d text:='outbox@example.invalid'; rid uuid:=gen_random_uuid(); j uuid; a jsonb; oldlease uuid; ev uuid:=gen_random_uuid(); n int; outcome text;
begin
 if has_table_privilege('hag_email_worker','hag_private.subscription_email_outbox','select') or has_function_privilege('anon','hag_private.subscription_email_claim()','execute') or has_function_privilege('hag_subscription_runtime','hag_private.subscription_email_sim_step(uuid,uuid,text,text,text)','execute') or has_function_privilege('hag_subscription_runtime','hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text)','execute') or has_function_privilege('hag_email_worker','hag_private.subscription_email_sim_event(uuid,uuid,text)','execute') then raise exception 'permission boundary';end if;
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(rid,'subscribe','Fixture',true,d,array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v1');
 perform hag_private.subscription_enqueue_email(rid,'subscribe','Fixture',true,d,array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v1');
 execute 'reset role';
 select id into strict j from hag_private.subscription_email_outbox where request_id=rid;
 if (select count(*) from hag_private.subscription_email_outbox where request_id=rid)<>1 then raise exception 'duplicate enqueue';end if;
 if exists(select 1 from hag_private.subscription_email_outbox where id=j and position(convert_to(d,'UTF8') in payload)>0) then raise exception 'plaintext in payload';end if;
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();oldlease:=(a->>'lease')::uuid;
 if (a->>'id')::uuid is distinct from j then raise exception 'claim failed';end if;
 if hag_private.subscription_email_claim() is not null then raise exception 'duplicate claim';end if;
 execute 'reset role';
 update hag_private.subscription_email_outbox set lease_until=clock_timestamp()-interval '1 second' where id=j;
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();
 if (a->>'lease')::uuid=oldlease or hag_private.subscription_email_sim_step(j,oldlease,k,'fixture-v1','accept')<>'stale' then raise exception 'stale fencing';end if;
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,repeat('b',64),'fixture-v1','accept')<>'key-unavailable' then raise exception 'wrong key';end if;
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,k,'fixture-v1','ambiguous')<>'retry' then raise exception 'ambiguous acceptance';end if;
 execute 'reset role';
 update hag_private.subscription_email_outbox set next_at=clock_timestamp()-interval '1 second' where id=j;
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,k,'fixture-v1','accept')<>'accepted' then raise exception 'reconciliation failed';end if;
 execute 'reset role';
 execute 'set local role hag_email_sim_event_ingestor';
 if not hag_private.subscription_email_sim_event(ev,j,'delivered') or hag_private.subscription_email_sim_event(ev,j,'delivered') then raise exception 'event idempotency';end if;
 execute 'reset role';
 if (select count(*) from hag_private.subscription_email_sim_acceptance where job_id=j)<>1 or (select reserved from hag_private.subscription_email_quota where period='day')<>1 or exists(select 1 from hag_private.subscription_email_outbox where id=j and payload is not null) then raise exception 'terminal accounting';end if;
 update hag_private.subscription_email_limits set daily=1 where singleton;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'subscribe','Fixture',true,'quota@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v1');
 execute 'reset role';
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();
 if hag_private.subscription_email_sim_step((a->>'id')::uuid,(a->>'lease')::uuid,k,'fixture-v1','accept')<>'quota' then raise exception 'quota bypass';end if;
 execute 'reset role';
 update hag_private.subscription_email_outbox set finished_at=clock_timestamp()-interval '2 days' where id=j;
 execute 'set local role hag_subscription_maintenance';
 n:=hag_private.subscription_email_cleanup();
 if n<>1 then raise exception 'cleanup mismatch';end if;
 execute 'reset role';
 if exists(select 1 from hag_private.subscription_email_outbox where id=j) then raise exception 'cleanup failed';end if;
end $qa$;
select 'PASS: durable atomic enqueue, lease recovery, stale worker fencing, wrong key rejection, lost ACK reconciliation, duplicate event, quota and cleanup' as result;

-- Additional integration/security assertions; rollback isolated fixtures independently.
begin;
alter table hag_private.subscription_email_outbox add constraint qa_injected_failure check(request_id<>'a0000000-0000-4000-8000-000000000001'::uuid);
do $qa$
declare k text:=repeat('d',64); d text:='rollback@example.invalid'; rid uuid:='a0000000-0000-4000-8000-000000000001'; j uuid; a jsonb; raw text; before_tokens int; before_consent int;
begin
 select count(*) into before_tokens from hag_private.subscription_capabilities;
 select count(*) into before_consent from hag_private.hag_consent_events;
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 begin
  perform hag_private.subscription_enqueue_email(rid,'subscribe','Fixture',true,d,array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v3');
  raise exception 'injected outbox failure was not triggered';
 exception when check_violation then null;
 end;
 begin
  perform hag_private.subscription_gateway_issue(gen_random_uuid(),'subscribe','Fixture',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1','confirm');
  raise exception 'raw email issue permission bypass';
 exception when insufficient_privilege then null;
 end;
 raw:=hag_private.subscription_gateway_issue_sms(gen_random_uuid(),'subscribe','Fixture',true,'+12025550126',array['hag-announcements'],true,'draft-3c3-v1','confirm');
 if raw is null then raise exception 'SMS fixture wrapper not working';end if;
 execute 'reset role';
 if exists(select 1 from hag_private.hag_contact_methods where destination=d) or exists(select 1 from hag_private.subscription_issue_keys where request_id=rid) or (select count(*) from hag_private.subscription_capabilities)<>before_tokens+1 or (select count(*) from hag_private.hag_consent_events)<>before_consent+1 then raise exception 'atomic rollback incomplete';end if;
 -- Verify a lost acknowledgement reconciles even after the key is unavailable.
 update hag_private.subscription_email_limits set daily=80,monthly=2400 where singleton;
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'subscribe','Fixture',true,'lost-key@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v3');
 execute 'reset role';
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();j:=(a->>'id')::uuid;
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,k,'fixture-v3','ambiguous')<>'retry' then raise exception 'ambiguous test failed';end if;
 execute 'reset role';
 update hag_private.subscription_email_outbox set next_at=clock_timestamp()-interval '1 second' where id=j;
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,null,'fixture-v3','accept')<>'accepted' then raise exception 'key-independent reconciliation failed';end if;
 execute 'reset role';
 -- Repeated missing-key/abandoned leases are bounded without accepting a message.
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'subscribe','Fixture',true,'lease-cap@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v3');
 execute 'reset role';
 execute 'set local role hag_email_worker';
 a:=hag_private.subscription_email_claim();j:=(a->>'id')::uuid;
 if hag_private.subscription_email_sim_step(j,(a->>'lease')::uuid,null,'fixture-v3','accept')<>'key-unavailable' then raise exception 'missing key accepted';end if;
 execute 'reset role';
 update hag_private.subscription_email_outbox set claims=8,lease_until=clock_timestamp()-interval '1 second' where id=j;
 execute 'set local role hag_email_worker';
 if hag_private.subscription_email_claim() is not null then raise exception 'claim limit bypass';end if;
 execute 'reset role';
 if not exists(select 1 from hag_private.subscription_email_outbox where id=j and state='failed' and payload is null) then raise exception 'claim limit did not clear payload';end if;
 -- Backlog limit: no contact/token is created when queue has reached capacity.
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 select gen_random_uuid(),gen_random_uuid(),decode('00','hex'),'fixture-v3',clock_timestamp()+interval '15 minutes' from generate_series(1,200);
 delete from hag_private.subscription_abuse;
 execute 'set local role hag_subscription_runtime';
 perform hag_private.subscription_enqueue_email(gen_random_uuid(),'subscribe','Fixture',true,'queue-full@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm',k,'fixture-v3');
 execute 'reset role';
 if exists(select 1 from hag_private.hag_contact_methods where destination='queue-full@example.invalid') then raise exception 'backlog overflow issued token';end if;
end $qa$;
select 'PASS: atomic rollback on outbox failure, direct issuance denied, SMS isolation, lost-key reconciliation, bounded lease claims and backlog' as result;
rollback;
