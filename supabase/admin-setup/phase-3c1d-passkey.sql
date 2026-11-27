-- DRAFT: apply only after separate deployment approval in HAG Administration.
-- No change to Supabase Auth's AAL classification. A passkey alternative is limited
-- to the exact session created from a server-verified, user-verified assertion.
create table hag_private.hag_approved_passkeys (
 credential_id uuid primary key,
 user_id uuid not null references hag_private.hag_staff(user_id) on delete cascade,
 approved_at timestamptz not null default now(),
 revoked_at timestamptz,
 unique(credential_id,user_id)
);
create table hag_private.hag_verified_passkey_sessions (
 session_id uuid primary key,
 credential_id uuid not null,
 user_id uuid not null,
 verified_at timestamptz not null default now(),
 foreign key (credential_id,user_id) references hag_private.hag_approved_passkeys(credential_id,user_id) on delete cascade
);
alter table hag_private.hag_approved_passkeys enable row level security;
alter table hag_private.hag_approved_passkeys force row level security;
alter table hag_private.hag_verified_passkey_sessions enable row level security;
alter table hag_private.hag_verified_passkey_sessions force row level security;
revoke all on hag_private.hag_approved_passkeys,hag_private.hag_verified_passkey_sessions from public,anon,authenticated,service_role;
-- The gateway alone can call this writer, only after verifying the assertion with
-- Supabase Auth. Browser-supplied session IDs, tokens, or UV booleans are never accepted.
create function hag_private.record_verified_passkey(p_session_id uuid,p_user_id uuid,p_credential_b64 text)
returns boolean language plpgsql volatile security definer set search_path='' as $fn$
declare cid uuid;
begin
 if p_credential_b64 is null or length(p_credential_b64) not between 4 and 1400 then return false; end if;
 select c.id into cid
 from auth.webauthn_credentials c
 join hag_private.hag_approved_passkeys a on a.credential_id=c.id and a.user_id=c.user_id and a.revoked_at is null
 join hag_private.hag_staff h on h.user_id=c.user_id and h.active and h.role='admin'
 join auth.users u on u.id=h.user_id and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
 join auth.sessions s on s.user_id=u.id
 where c.user_id=p_user_id and c.credential_id=decode(p_credential_b64,'base64')
 and s.id=p_session_id and s.created_at > now()-interval '2 minutes'
 and (s.not_after is null or s.not_after>now()) and (u.banned_until is null or u.banned_until<=now())
 and exists(select 1 from auth.mfa_amr_claims m where m.session_id=s.id and m.authentication_method='passkey')
 and exists(select 1 from auth.mfa_factors f where f.user_id=u.id and f.factor_type::text='totp' and f.status::text='verified');
 if cid is null then return false; end if;
 delete from hag_private.hag_verified_passkey_sessions where verified_at<=now()-interval '12 hours';
 insert into hag_private.hag_verified_passkey_sessions(session_id,credential_id,user_id)
 values(p_session_id,cid,p_user_id) on conflict(session_id) do nothing;
 return found;
end $fn$;
revoke all on function hag_private.record_verified_passkey(uuid,uuid,text) from public,anon,authenticated,service_role;
grant usage on schema hag_private to service_role;
grant execute on function hag_private.record_verified_passkey(uuid,uuid,text) to service_role;
create function public.hag_record_verified_passkey(p_session_id uuid,p_user_id uuid,p_credential_b64 text)
returns boolean language sql volatile security invoker set search_path='' as $fn$
select hag_private.record_verified_passkey(p_session_id,p_user_id,p_credential_b64)
$fn$;
revoke all on function public.hag_record_verified_passkey(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.hag_record_verified_passkey(uuid,uuid,text) to service_role;
create or replace function hag_private.admin_session_state() returns text
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  uid uuid := auth.uid();
  claims jsonb := auth.jwt();
  sid text := claims->>'session_id';
begin
  if uid is null or sid is null or sid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return 'denied';
  end if;
  if not exists(
    select 1 from hag_private.hag_staff staff
    join auth.users u on u.id=staff.user_id
    join auth.sessions s on s.user_id=u.id
    where staff.user_id=uid and staff.active and staff.role='admin'
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
      and (u.banned_until is null or u.banned_until <= now())
      and s.id=sid::uuid and s.created_at > now()-interval '12 hours'
      and (s.not_after is null or s.not_after > now())
  ) then return 'denied'; end if;
  if not exists(select 1 from auth.mfa_factors f
    where f.user_id=uid and f.factor_type::text='totp' and f.status::text='verified')
  then return 'enroll'; end if;
  if claims->>'aal' = 'aal2' then return 'authorized'; end if;
  if not exists(select 1 from hag_private.hag_verified_passkey_sessions g
    join hag_private.hag_approved_passkeys a on a.credential_id=g.credential_id and a.user_id=g.user_id and a.revoked_at is null
    join auth.webauthn_credentials c on c.id=a.credential_id and c.user_id=a.user_id
    join auth.sessions s on s.id=g.session_id and s.user_id=g.user_id
    where g.session_id=sid::uuid and g.user_id=uid and g.verified_at >= s.created_at and g.verified_at > now()-interval '12 hours'
    and exists(select 1 from auth.mfa_amr_claims m where m.session_id=s.id and m.authentication_method='passkey')) then return 'challenge'; end if;
  return 'authorized';
end;
$fn$;

-- Do not automatically approve existing credentials. After explicit activation
-- approval, the owner must identify and approve the already enrolled credential
-- using trusted SQL administration. New registrations need the same review.
