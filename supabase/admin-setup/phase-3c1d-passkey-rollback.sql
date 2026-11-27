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
  if claims->>'aal' is distinct from 'aal2' then return 'challenge'; end if;
  return 'authorized';
end;
$fn$;

drop function public.hag_record_verified_passkey(uuid,uuid,text);
drop function hag_private.record_verified_passkey(uuid,uuid,text);
drop table hag_private.hag_verified_passkey_sessions;
drop table hag_private.hag_approved_passkeys;
revoke usage on schema hag_private from service_role;
