-- UNPUBLISHED, synthetic-only final Gmail stage. Never install on hosted database.
-- All credentials/state encrypted by trusted server with external AES-GCM key.
create role hag_gmail_control nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role hag_gmail_dispatch nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_gmail_control,hag_gmail_dispatch;
create table hag_private.gmail_connection (
 singleton boolean primary key check(singleton), generation bigint not null default 0,
 enabled boolean not null default false, credential text, key_version text,
 check (not enabled or credential is not null),
 check ((credential is null)=(key_version is null))
);
insert into hag_private.gmail_connection(singleton) values(true);
create table hag_private.gmail_oauth_state (
 digest text primary key check(digest ~ '^[a-f0-9]{64}$'), actor uuid not null, session_id uuid not null,
 generation bigint not null, verifier text not null check(length(verifier)<=2048),
 expires_at timestamptz not null default clock_timestamp()+interval '5 minutes'
);
create table hag_private.gmail_dispatch_receipt (
 job_id uuid primary key, ticket uuid unique not null, generation bigint not null,
 outcome text not null check(outcome in ('ambiguous-hold-no-resend','accepted-not-delivered','authorization-required','hold-quota-or-policy-review','permanent-or-configuration-review')),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz
);
alter table hag_private.gmail_connection enable row level security;
alter table hag_private.gmail_connection force row level security;
alter table hag_private.gmail_oauth_state enable row level security;
alter table hag_private.gmail_oauth_state force row level security;
alter table hag_private.gmail_dispatch_receipt enable row level security;
alter table hag_private.gmail_dispatch_receipt force row level security;
revoke all on hag_private.gmail_connection,hag_private.gmail_oauth_state,hag_private.gmail_dispatch_receipt from public,anon,authenticated,service_role,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance,hag_gmail_control,hag_gmail_dispatch;
-- Only the trusted server control role can bind an independently verified admin/session.
create function hag_private.gmail_begin(p_digest text,p_actor uuid,p_session uuid,p_verifier text)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare g bigint;
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_actor is null or p_session is null or p_verifier is null or length(p_verifier) not between 1 and 2048 then return null;end if;
 select generation into g from hag_private.gmail_connection where singleton for update;
 delete from hag_private.gmail_oauth_state where expires_at<=clock_timestamp() or actor=p_actor;
 if (select count(*) from hag_private.gmail_oauth_state)>=20 then return null;end if;
 insert into hag_private.gmail_oauth_state(digest,actor,session_id,generation,verifier) values(p_digest,p_actor,p_session,g,p_verifier);
 return g;
end $$;
create function hag_private.gmail_take(p_digest text,p_actor uuid,p_session uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r hag_private.gmail_oauth_state; g bigint;
begin
 select generation into g from hag_private.gmail_connection where singleton for update;
 delete from hag_private.gmail_oauth_state where digest=p_digest and actor=p_actor and session_id=p_session and generation=g and expires_at>clock_timestamp() returning * into r;
 if r.digest is null then return null;end if;
 return jsonb_build_object('generation',r.generation,'verifier',r.verifier);
end $$;
create function hag_private.gmail_store(p_generation bigint,p_credential text,p_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 if p_credential is null or length(p_credential) not between 1 and 16384 or p_version is null or p_version !~ '^[a-zA-Z0-9_-]{1,32}$' then return false;end if;
 update hag_private.gmail_connection set credential=p_credential,key_version=p_version,enabled=false,generation=generation+1 where singleton and generation=p_generation;
 get diagnostics n=row_count;
 if n=1 then delete from hag_private.gmail_oauth_state;end if;
 return n=1;
end $$;
create function hag_private.gmail_status()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('connected',credential is not null,'enabled',enabled,'generation',generation) from hag_private.gmail_connection where singleton
$$;
create function hag_private.gmail_disable(p_disconnect boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare r hag_private.gmail_connection;
begin
 select * into r from hag_private.gmail_connection where singleton for update;
 update hag_private.gmail_connection set enabled=false,generation=generation+1,credential=case when p_disconnect then null else credential end,key_version=case when p_disconnect then null else key_version end where singleton;
 delete from hag_private.gmail_oauth_state;
 -- Only control server can retrieve encrypted revoked credential, never the UI.
 return case when p_disconnect then jsonb_build_object('credential',r.credential,'key_version',r.key_version) else '{}'::jsonb end;
end $$;
-- TEST-ONLY enabling for simulated transport. No production enable route.
create function hag_private.gmail_enable_fixture(p_generation bigint)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 update hag_private.gmail_connection set enabled=true where singleton and generation=p_generation and credential is not null;
 get diagnostics n=row_count;return n=1;
end $$;
create function hag_private.gmail_claim()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 if not exists(select 1 from hag_private.gmail_connection where singleton and enabled) then return null;end if;
 return hag_private.subscription_email_claim();
end $$;
-- Reserve BEFORE any external call. Crash after reserve is held, never automatically resent.
create function hag_private.gmail_reserve(p_job uuid,p_lease uuid,p_key text,p_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j hag_private.subscription_email_outbox; c hag_private.gmail_connection; v jsonb; lim hag_private.subscription_email_limits; d date; mo date; ticket uuid:=gen_random_uuid();
begin
 select * into j from hag_private.subscription_email_outbox where id=p_job for update;
 if j.id is null or j.state<>'leased' or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 if p_key is null or p_key !~ '^[a-f0-9]{64}$' or p_version is distinct from j.key_version then return null;end if;
 begin v:=extensions.pgp_sym_decrypt(j.payload,p_key)::jsonb;exception when others then return null;end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||(v->>'destination'),0));
 select * into c from hag_private.gmail_connection where singleton for update;
 if not c.enabled or c.credential is null or j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 if (v->>'destination') !~ '^[a-z0-9._+%-]+@[a-z0-9.-]+[.]invalid$' or not hag_private.subscription_email_delivery_eligible(v->>'token',v->>'destination',v->>'purpose') then
  update hag_private.subscription_email_outbox set state='cancelled',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return null;
 end if;
 select * into strict lim from hag_private.subscription_email_limits where singleton for update;
 if j.lease_until<=clock_timestamp() or j.deadline<=clock_timestamp() then return null;end if;
 d:=(clock_timestamp() at time zone 'UTC')::date;mo:=date_trunc('month',d::timestamp)::date;
 if coalesce((select reserved from hag_private.subscription_email_quota where period='day' and bucket=d),0)>=lim.daily or coalesce((select reserved from hag_private.subscription_email_quota where period='month' and bucket=mo),0)>=lim.monthly then
  update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null where id=j.id;return null;
 end if;
 insert into hag_private.subscription_email_quota values('day',d,1),('month',mo,1) on conflict(period,bucket) do update set reserved=hag_private.subscription_email_quota.reserved+1;
 insert into hag_private.gmail_dispatch_receipt(job_id,ticket,generation,outcome) values(j.id,ticket,c.generation,'ambiguous-hold-no-resend');
 update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null,attempts=attempts+1 where id=j.id;
 return jsonb_build_object('id',j.id,'ticket',ticket,'generation',c.generation,'credential',c.credential,'key_version',c.key_version,'message',v);
end $$;
create function hag_private.gmail_dispatch_allowed(p_ticket uuid,p_generation bigint)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from hag_private.gmail_connection c join hag_private.gmail_dispatch_receipt r on r.generation=c.generation where c.singleton and c.enabled and c.generation=p_generation and r.ticket=p_ticket and r.finished_at is null and r.created_at>statement_timestamp()-interval '30 seconds')
$$;
create function hag_private.gmail_finish(p_ticket uuid,p_outcome text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare j uuid; g bigint;
begin
 if p_outcome is null or p_outcome not in ('ambiguous-hold-no-resend','accepted-not-delivered','authorization-required','hold-quota-or-policy-review','permanent-or-configuration-review') then return false;end if;
 update hag_private.gmail_dispatch_receipt set outcome=p_outcome,finished_at=clock_timestamp() where ticket=p_ticket and finished_at is null returning job_id,generation into j,g;
 if j is null then return false;end if;
 if p_outcome='accepted-not-delivered' then update hag_private.subscription_email_outbox set state='accepted' where id=j;end if;
 if p_outcome in ('authorization-required','hold-quota-or-policy-review') then update hag_private.gmail_connection set enabled=false,generation=generation+1 where singleton and generation=g;end if;
 return true;
end $$;
revoke all on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint),hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint),hag_private.gmail_finish(uuid,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint) to hag_gmail_control;
grant execute on function hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint),hag_private.gmail_finish(uuid,text) to hag_gmail_dispatch;
-- Final worker cannot bypass the durable pre-dispatch reservation via historical sim step.
revoke execute on function hag_private.subscription_email_claim(),hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) from hag_email_worker;
