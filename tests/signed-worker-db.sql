begin;
do $qa$
declare n uuid:=gen_random_uuid(); g bigint; stamp bigint:=floor(extract(epoch from clock_timestamp()))::bigint;
begin
 if has_function_privilege('anon','hag_private.gmail_worker_consume(uuid,bigint)','execute') or has_function_privilege('hag_gmail_dispatch','hag_private.gmail_worker_consume(uuid,bigint)','execute') then raise exception 'worker grants premature';end if;
 if hag_private.gmail_worker_consume(n,stamp) then raise exception 'disabled worker accepted';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 if not hag_private.gmail_store(g,'fixture-encrypted','fixture') then raise exception 'fixture store';end if;
 g:=(hag_private.gmail_status()->>'generation')::bigint;
 execute 'set local role hag_gmail_release_operator';
 if not hag_private.gmail_record_sender_review(g,'no-reply@heartlandathleticsgroup.com','fixture-review',true,true,true,true,true,true,true) or not hag_private.gmail_enable_reviewed(g) then raise exception 'fixture enable';end if;
 execute 'reset role';
 if hag_private.gmail_worker_consume(n,stamp-61) or not hag_private.gmail_worker_consume(n,stamp) or hag_private.gmail_worker_consume(n,stamp) then raise exception 'worker nonce expiry or replay';end if;
end $qa$;
rollback;
select 'PASS: disabled delivery gate, expiry and durable scheduler nonce replay rejection' as result;
