-- UNPUBLISHED synthetic-only outbox draft; load after email-readiness-draft.
-- The externally supplied 256-bit key is never stored in this database.
create table hag_private.subscription_email_outbox (
 id uuid primary key, request_id uuid unique not null, payload bytea, key_version text not null,
 state text not null default 'queued' check(state in ('queued','leased','retry','accepted','cancelled','expired','failed')),
 attempts integer not null default 0 check(attempts between 0 and 3),
 claims integer not null default 0 check(claims between 0 and 8),
 created_at timestamptz not null default clock_timestamp(), deadline timestamptz not null,
 next_at timestamptz not null default clock_timestamp(), lease uuid, lease_until timestamptz,
 finished_at timestamptz,
 check ((state in ('accepted','cancelled','expired','failed'))=(payload is null))
);
create index on hag_private.subscription_email_outbox(state,next_at);
create table hag_private.subscription_email_quota (
 period text not null, bucket date not null, reserved integer not null check(reserved>=0), primary key(period,bucket)
);
create table hag_private.subscription_email_sim_acceptance (
 job_id uuid primary key references hag_private.subscription_email_outbox(id) on delete cascade,
 accepted_at timestamptz not null default clock_timestamp()
);
create table hag_private.subscription_email_sim_events (
 event_id uuid primary key, job_id uuid not null references hag_private.subscription_email_outbox(id) on delete cascade,
 event_kind text not null check(event_kind in ('delivered','bounced')), received_at timestamptz not null default clock_timestamp()
);
create table hag_private.subscription_email_limits (
 singleton boolean primary key check(singleton), daily integer not null check(daily between 1 and 100),
 monthly integer not null check(monthly between 1 and 3000)
);
insert into hag_private.subscription_email_limits values(true,80,2400);
alter table hag_private.subscription_email_outbox enable row level security;
alter table hag_private.subscription_email_outbox force row level security;
revoke all on hag_private.subscription_email_outbox from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_quota enable row level security;
alter table hag_private.subscription_email_quota force row level security;
revoke all on hag_private.subscription_email_quota from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_sim_acceptance enable row level security;
alter table hag_private.subscription_email_sim_acceptance force row level security;
revoke all on hag_private.subscription_email_sim_acceptance from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_sim_events enable row level security;
alter table hag_private.subscription_email_sim_events force row level security;
revoke all on hag_private.subscription_email_sim_events from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
alter table hag_private.subscription_email_limits enable row level security;
alter table hag_private.subscription_email_limits force row level security;
revoke all on hag_private.subscription_email_limits from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance;
create role hag_email_sim_event_ingestor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_email_sim_event_ingestor;
create role hag_email_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_email_worker;
-- Atomic issue + outbox insert. A failed insert rolls back token issuance as well.
-- Reserved synthetic domains only. PGP symmetric authenticated integrity, external key.
create function hag_private.subscription_enqueue_email(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $fn$
declare raw text; j uuid:=gen_random_uuid();
begin
 if p_destination is null or p_destination !~ '^[a-z0-9._+%-]+@[a-z0-9.-]+[.]invalid$' or p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid isolated email configuration';end if;
 -- Serialize admission only; bounded backlog, no token created when full.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then return; end if;
 raw:=hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version,p_purpose);
 if raw is null then return; end if;
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose',p_purpose,'token',raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
end $fn$;
-- Claim commits a unique fencing token; expired leases can be reclaimed.
create function hag_private.subscription_email_claim()
returns jsonb language plpgsql volatile security definer set search_path='' as $fn$
declare j hag_private.subscription_email_outbox;
begin
 select * into j from hag_private.subscription_email_outbox
 where state in ('queued','retry','leased') and (state<>'leased' or lease_until<=clock_timestamp())
 and next_at<=clock_timestamp() order by next_at,id limit 1 for update skip locked;
 if j.id is null then return null;end if;
 if j.deadline<=clock_timestamp() or j.attempts>=3 or j.claims>=8 then
  update hag_private.subscription_email_outbox set state=case when exists(select 1 from hag_private.subscription_email_sim_acceptance a where a.job_id=j.id) then 'accepted' when deadline<=clock_timestamp() then 'expired' else 'failed' end,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;
  return null;
 end if;
 update hag_private.subscription_email_outbox set state='leased',claims=claims+1,lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'lease',j.lease,'key_version',j.key_version);
end $fn$;
-- Simulated dispatch/reconciliation only. No external call. Row lock fences stale workers.
-- Quota is charged for each unique accepted job, never for a simulated lost ACK.
create function hag_private.subscription_email_sim_step(p_job uuid,p_lease uuid,p_key text,p_key_version text,p_outcome text)
returns text language plpgsql volatile security definer set search_path='' as $fn$
declare j hag_private.subscription_email_outbox; v jsonb; d date; mo date; lim hag_private.subscription_email_limits; daily_n int; monthly_n int;
begin
 if p_outcome is null or p_outcome not in ('accept','ambiguous','transient','permanent') then return 'invalid';end if;
 select * into j from hag_private.subscription_email_outbox where id=p_job for update;
 if p_lease is null or j.id is null or j.state<>'leased' or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() then return 'stale';end if;
 -- Reconcile an already-accepted job before eligibility or expiry checks.
 if exists(select 1 from hag_private.subscription_email_sim_acceptance where job_id=j.id) then
  update hag_private.subscription_email_outbox set state='accepted',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'accepted';
 end if;
 if j.deadline<=clock_timestamp() then
  update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'expired';
 end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is distinct from j.key_version then return 'key-unavailable';end if;
 begin v:=extensions.pgp_sym_decrypt(j.payload,p_key)::jsonb;exception when others then return 'key-unavailable';end;
 -- Share the destination lock with confirmation, preference edits and withdrawal.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||(v->>'destination'),0));
 if j.lease_until<=clock_timestamp() then return 'stale'; end if;
 if j.deadline<=clock_timestamp() then
  update hag_private.subscription_email_outbox set state='expired',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'expired';
 end if;
 if not hag_private.subscription_email_delivery_eligible(v->>'token',v->>'destination',v->>'purpose') then
  update hag_private.subscription_email_outbox set state='cancelled',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'cancelled';
 end if;
 if p_outcome in ('accept','ambiguous') then
  -- Serialize the small quota ledger across all workers; UTC fixed calendar buckets.
  select * into strict lim from hag_private.subscription_email_limits where singleton for update;
  d:=(clock_timestamp() at time zone 'UTC')::date;mo:=date_trunc('month',d::timestamp)::date;
  select coalesce((select reserved from hag_private.subscription_email_quota where period='day' and bucket=d),0) into daily_n;
  select coalesce((select reserved from hag_private.subscription_email_quota where period='month' and bucket=mo),0) into monthly_n;
  if daily_n>=lim.daily or monthly_n>=lim.monthly then
   update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'quota';
  end if;
  insert into hag_private.subscription_email_quota values('day',d,1),('month',mo,1) on conflict(period,bucket) do update set reserved=hag_private.subscription_email_quota.reserved+1;
  insert into hag_private.subscription_email_sim_acceptance(job_id) values(j.id);
 end if;
 if p_outcome='accept' or (p_outcome='ambiguous' and j.attempts=2) then
  update hag_private.subscription_email_outbox set state='accepted',attempts=attempts+1,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'accepted';
 end if;
 if p_outcome='permanent' or j.attempts=2 then
  update hag_private.subscription_email_outbox set state='failed',attempts=attempts+1,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return 'failed';
 end if;
 update hag_private.subscription_email_outbox set state='retry',attempts=attempts+1,next_at=clock_timestamp()+case when attempts=0 then interval '30 seconds' else interval '2 minutes' end,lease=null,lease_until=null where id=j.id;
 return 'retry';
end $fn$;
-- Synthetic event ingestion only; no provider signature or suppression sync asserted.
create function hag_private.subscription_email_sim_event(p_event uuid,p_job uuid,p_kind text)
returns boolean language plpgsql volatile security definer set search_path='' as $fn$
declare n int;
begin
 if p_event is null or p_kind is null or p_kind not in ('delivered','bounced') or not exists(select 1 from hag_private.subscription_email_sim_acceptance where job_id=p_job) then return false;end if;
 insert into hag_private.subscription_email_sim_events(event_id,job_id,event_kind) values(p_event,p_job,p_kind) on conflict do nothing;
 get diagnostics n=row_count;return n=1;
end $fn$;
create function hag_private.subscription_email_cleanup()
returns integer language plpgsql volatile security definer set search_path='' as $fn$
declare n int;
begin
 update hag_private.subscription_email_outbox set state=case when exists(select 1 from hag_private.subscription_email_sim_acceptance a where a.job_id=subscription_email_outbox.id) then 'accepted' else 'expired' end,payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null
 where id in (select id from hag_private.subscription_email_outbox where state in ('queued','retry','leased') and deadline<=clock_timestamp() and (state<>'leased' or lease_until<=clock_timestamp()) limit 500 for update skip locked);
 delete from hag_private.subscription_email_outbox where id in (select id from hag_private.subscription_email_outbox where finished_at<clock_timestamp()-interval '1 day' limit 500 for update skip locked);
 get diagnostics n=row_count;
 delete from hag_private.subscription_email_quota where bucket<(clock_timestamp() at time zone 'UTC')::date-62;
 return n;
end $fn$;
revoke all on function hag_private.subscription_enqueue_email(uuid,text,text,boolean,text,text[],boolean,text,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_claim() from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_sim_event(uuid,uuid,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
revoke all on function hag_private.subscription_email_cleanup() from public,anon,authenticated,service_role,hag_subscription_runtime,hag_subscription_maintenance,hag_email_worker;
grant execute on function hag_private.subscription_enqueue_email(uuid,text,text,boolean,text,text[],boolean,text,text,text,text) to hag_subscription_runtime;
grant execute on function hag_private.subscription_email_claim(),hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) to hag_email_worker;
grant execute on function hag_private.subscription_email_sim_event(uuid,uuid,text) to hag_email_sim_event_ingestor;
grant execute on function hag_private.subscription_email_cleanup() to hag_subscription_maintenance;

-- Atomic email is now the only issuance path for the runtime. Preserve SMS fixture flow
-- through a fixed-channel wrapper; never return a raw email capability to the gateway.
create function hag_private.subscription_gateway_issue_sms(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text)
returns text language plpgsql volatile security definer set search_path='' as $sms$
begin
 if p_destination is null or p_destination !~ '^[+]1[2-9][0-9]{2}55501[0-9]{2}$' then return null;end if;
 return hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'sms',p_destination,p_topics,p_consent,p_version,p_purpose);
end $sms$;
revoke all on function hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text) from public,anon,authenticated,service_role,hag_email_worker,hag_email_sim_event_ingestor,hag_subscription_maintenance;
grant execute on function hag_private.subscription_gateway_issue_sms(uuid,text,text,boolean,text,text[],boolean,text,text) to hag_subscription_runtime;
revoke execute on function hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text) from hag_subscription_runtime;
revoke execute on function hag_private.subscription_email_delivery_eligible(text,text,text) from hag_subscription_runtime;
-- Dedicated event ingestor is synthetic only; no public webhook or provider signature.
