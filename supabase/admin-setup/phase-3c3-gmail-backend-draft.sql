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
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz, started_at timestamptz, message_digest text not null
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
 select generation into g from hag_private.gmail_connection where singleton and credential is null for update;
 if g is null then return null;end if;
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
 update hag_private.gmail_connection set credential=p_credential,key_version=p_version,enabled=false,generation=generation+1 where singleton and generation=p_generation and credential is null;
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
 if (select count(*) from hag_private.gmail_dispatch_receipt where outcome='ambiguous-hold-no-resend' and reviewed_at is null)>=500 then return null;end if;
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
 insert into hag_private.gmail_dispatch_receipt(job_id,ticket,generation,outcome,message_digest) values(j.id,ticket,c.generation,'ambiguous-hold-no-resend',encode(extensions.digest((v->>'destination')||':'||(v->>'purpose')||':'||(v->>'token'),'sha256'),'hex'));
 update hag_private.subscription_email_outbox set state='failed',payload=null,finished_at=clock_timestamp(),lease=null,lease_until=null,attempts=attempts+1 where id=j.id;
 return jsonb_build_object('id',j.id,'ticket',ticket,'generation',c.generation,'credential',c.credential,'key_version',c.key_version,'message',v);
end $$;
create function hag_private.gmail_dispatch_allowed(p_ticket uuid,p_generation bigint,p_destination text,p_purpose text,p_token text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare n int; c hag_private.gmail_connection;
begin
 if p_destination is null or p_purpose is null or p_token is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 select * into c from hag_private.gmail_connection where singleton for update;
 if not c.enabled or c.generation is distinct from p_generation or not hag_private.subscription_email_delivery_eligible(p_token,p_destination,p_purpose) then return false;end if;
 update hag_private.gmail_dispatch_receipt set started_at=clock_timestamp() where ticket=p_ticket and generation=p_generation and started_at is null and finished_at is null and created_at>clock_timestamp()-interval '30 seconds' and message_digest=encode(extensions.digest(p_destination||':'||p_purpose||':'||p_token,'sha256'),'hex');
 get diagnostics n=row_count;return n=1;
end $$;
create function hag_private.gmail_finish(p_ticket uuid,p_outcome text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare j uuid; g bigint;
begin
 if p_outcome is null or p_outcome not in ('ambiguous-hold-no-resend','accepted-not-delivered','authorization-required','hold-quota-or-policy-review','permanent-or-configuration-review') then return false;end if;
 perform 1 from hag_private.gmail_connection where singleton for update;
 update hag_private.gmail_dispatch_receipt set outcome=p_outcome,finished_at=clock_timestamp() where ticket=p_ticket and finished_at is null and (p_outcome<>'accepted-not-delivered' or started_at is not null) returning job_id,generation into j,g;
 if j is null then return false;end if;
 if p_outcome='accepted-not-delivered' then update hag_private.subscription_email_outbox set state='accepted' where id=j;end if;
 if p_outcome in ('authorization-required','hold-quota-or-policy-review') then update hag_private.gmail_connection set enabled=false,generation=generation+1 where singleton and generation=g;end if;
 return true;
end $$;
revoke all on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint),hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint,text,text,text),hag_private.gmail_finish(uuid,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.gmail_begin(text,uuid,uuid,text),hag_private.gmail_take(text,uuid,uuid),hag_private.gmail_store(bigint,text,text),hag_private.gmail_status(),hag_private.gmail_disable(boolean),hag_private.gmail_enable_fixture(bigint) to hag_gmail_control;
grant execute on function hag_private.gmail_claim(),hag_private.gmail_reserve(uuid,uuid,text,text),hag_private.gmail_dispatch_allowed(uuid,bigint,text,text,text),hag_private.gmail_finish(uuid,text) to hag_gmail_dispatch;
-- Final worker cannot bypass the durable pre-dispatch reservation via historical sim step.
revoke execute on function hag_private.subscription_email_claim(),hag_private.subscription_email_sim_step(uuid,uuid,text,text,text) from hag_email_worker;

-- New read-only admin bridge uses the existing gate, not client assertions.
-- In production it must be invoked with the initiating user's verified JWT.
create function hag_private.gmail_admin_proof()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid uuid; recent timestamptz;
begin
 if uid is null or hag_private.admin_session_state() is distinct from 'authorized' or coalesce(claims->>'session_id','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then return null;end if;
 sid:=(claims->>'session_id')::uuid;
 -- The existing gate checks current active staff, auth.users, auth.sessions,
 -- verified TOTP enrollment, and approved passkey session where appropriate.
 select max(t.at) into recent from (
 -- Use the original factor assertion timestamp conservatively; refreshing a row must not extend step-up.
 select m.created_at as at from auth.mfa_amr_claims m
 where m.session_id=sid and m.authentication_method='totp' and claims->>'aal'='aal2'
 union all
 select g.verified_at from hag_private.hag_verified_passkey_sessions g
 join hag_private.hag_approved_passkeys a on a.credential_id=g.credential_id and a.user_id=g.user_id and a.revoked_at is null
 join auth.webauthn_credentials c on c.id=a.credential_id and c.user_id=a.user_id
 where g.session_id=sid and g.user_id=uid and exists(select 1 from auth.mfa_amr_claims m where m.session_id=sid and m.authentication_method='passkey')
 ) t where t.at<=now() and t.at>now()-interval '5 minutes';
 if recent is null then return null;end if;
 return jsonb_build_object('actor',uid,'session',sid,'gate','authorized','sessionActive',true,'stepUpAt',floor(extract(epoch from recent)*1000)::bigint);
end $$;
revoke all on function hag_private.gmail_admin_proof() from public,anon,authenticated,service_role;
grant execute on function hag_private.gmail_admin_proof() to authenticated;
create function public.hag_gmail_admin_proof()
returns jsonb language sql stable security invoker set search_path='' as $$ select hag_private.gmail_admin_proof() $$;
revoke all on function public.hag_gmail_admin_proof() from public,anon,authenticated,service_role;
grant execute on function public.hag_gmail_admin_proof() to authenticated;

-- Phase 3C.3E.7 callback binding and operator safeguards; isolated draft only.
create table hag_private.gmail_callback_flow (
 digest text primary key check(digest ~ '^[a-f0-9]{64}$'),
 state_digest text not null unique references hag_private.gmail_oauth_state(digest) on delete cascade,
 ciphertext text not null check(length(ciphertext) between 1 and 8192),
 expires_at timestamptz not null default clock_timestamp()+interval '5 minutes'
);
alter table hag_private.gmail_callback_flow enable row level security;
alter table hag_private.gmail_callback_flow force row level security;
revoke all on hag_private.gmail_callback_flow from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch;
create function hag_private.gmail_flow_put(p_digest text,p_state text,p_cipher text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_state is null or p_cipher is null or length(p_cipher) not between 1 and 8192 then return false;end if;
 perform 1 from hag_private.gmail_connection where singleton for update;
 if not exists(select 1 from hag_private.gmail_oauth_state s join hag_private.gmail_connection c on c.generation=s.generation where s.digest=p_state and s.expires_at>clock_timestamp() and c.credential is null) then return false;end if;
 delete from hag_private.gmail_callback_flow where expires_at<=clock_timestamp();
 insert into hag_private.gmail_callback_flow(digest,state_digest,ciphertext) values(p_digest,p_state,p_cipher) on conflict do nothing;
 return found;
end $$;
create function hag_private.gmail_flow_take(p_digest text,p_state text)
returns text language plpgsql volatile security definer set search_path='' as $$
declare v text;
begin
 perform 1 from hag_private.gmail_connection where singleton for update;
 delete from hag_private.gmail_callback_flow where digest=p_digest and state_digest=p_state and expires_at>clock_timestamp() returning ciphertext into v;
 return v;
end $$;
-- Key rotation requires a disabled connection; ciphertext only, compare-and-swap.
create function hag_private.gmail_rotation_read()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('generation',generation,'credential',credential,'key_version',key_version)
 from hag_private.gmail_connection where singleton and not enabled and credential is not null
$$;
create function hag_private.gmail_rotation_commit(p_generation bigint,p_old_version text,p_new_version text,p_cipher text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_new_version is null or p_new_version !~ '^[A-Za-z0-9_-]{1,32}$' or p_new_version=p_old_version or p_cipher is null or length(p_cipher) not between 1 and 16384 then return false;end if;
 update hag_private.gmail_connection set credential=p_cipher,key_version=p_new_version,generation=generation+1
 where singleton and not enabled and credential is not null and generation=p_generation and key_version=p_old_version;
 if not found then return false;end if;
 delete from hag_private.gmail_oauth_state;
 return true;
end $$;
alter table hag_private.gmail_dispatch_receipt add column reviewed_at timestamptz,add column reviewed_by uuid,add column review_disposition text check(review_disposition in ('closed-unverified-no-resend','provider-acceptance-observed-no-resend'));
create function hag_private.gmail_review_list()
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at,q.job_id),'[]'::jsonb) from (
 select job_id,created_at,outcome,started_at is not null as started from hag_private.gmail_dispatch_receipt
 where outcome='ambiguous-hold-no-resend' and reviewed_at is null and created_at<statement_timestamp()-interval '1 minute'
 order by created_at,job_id limit 50) q
$$;
create function hag_private.gmail_review_close(p_job uuid,p_actor uuid,p_disposition text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
 if p_actor is null or p_disposition is null or p_disposition not in ('closed-unverified-no-resend','provider-acceptance-observed-no-resend') then return false;end if;
 update hag_private.gmail_dispatch_receipt set reviewed_at=clock_timestamp(),reviewed_by=p_actor,review_disposition=p_disposition,finished_at=coalesce(finished_at,clock_timestamp())
 where job_id=p_job and outcome='ambiguous-hold-no-resend' and reviewed_at is null and created_at<clock_timestamp()-interval '1 minute';
 return found;
end $$;
-- Cleanup only expired state and old closed metadata; never remove open holds.
create function hag_private.gmail_cleanup()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare n int;
begin
 delete from hag_private.gmail_oauth_state where expires_at<=clock_timestamp();
 delete from hag_private.gmail_callback_flow where expires_at<=clock_timestamp();
 delete from hag_private.gmail_dispatch_receipt where job_id in (
 select job_id from hag_private.gmail_dispatch_receipt where
 (reviewed_at<clock_timestamp()-interval '90 days' or (outcome<>'ambiguous-hold-no-resend' and finished_at<clock_timestamp()-interval '90 days'))
 order by created_at limit 500 for update skip locked);
 get diagnostics n=row_count;return n;
end $$;
revoke all on function hag_private.gmail_flow_put(text,text,text),hag_private.gmail_flow_take(text,text),hag_private.gmail_rotation_read(),hag_private.gmail_rotation_commit(bigint,text,text,text),hag_private.gmail_review_list(),hag_private.gmail_review_close(uuid,uuid,text),hag_private.gmail_cleanup() from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_email_worker,hag_subscription_maintenance;
grant execute on function hag_private.gmail_flow_put(text,text,text),hag_private.gmail_flow_take(text,text),hag_private.gmail_rotation_read(),hag_private.gmail_rotation_commit(bigint,text,text,text),hag_private.gmail_review_list(),hag_private.gmail_review_close(uuid,uuid,text) to hag_gmail_control;
grant execute on function hag_private.gmail_cleanup() to hag_subscription_maintenance;
