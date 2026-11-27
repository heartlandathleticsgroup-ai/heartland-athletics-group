-- STAGED ONLY. Apply to HAG Administration (unrqbfngcgvqnytxbtgj) after separate deployment approval.
-- Do not expose hag_private through the Data API. No direct client write grants.
create function hag_private.admin_session_state() returns text
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
-- This narrowly scoped private definer reads only the caller's staff/factor/session status.
-- auth.sessions is not granted to clients; the function returns a fixed state, never data.
revoke all on function hag_private.admin_session_state() from public, anon, authenticated, service_role;
grant execute on function hag_private.admin_session_state() to authenticated;
create or replace function hag_private.is_active_admin() returns boolean
language sql stable security invoker set search_path=''
as $fn$ select hag_private.admin_session_state()='authorized' $fn$;
revoke all on function hag_private.is_active_admin() from public, anon, authenticated, service_role;
grant execute on function hag_private.is_active_admin() to authenticated;
alter policy staff_read_own_active_mfa on hag_private.hag_staff
 using (user_id=(select auth.uid()) and (select hag_private.is_active_admin()));
-- Single public RPC: security invoker, returns a fixed state for authenticated caller only.
create function public.hag_admin_access_state() returns text
language sql stable security invoker set search_path=''
as $fn$ select hag_private.admin_session_state() $fn$;
revoke all on function public.hag_admin_access_state() from public, anon, authenticated, service_role;
grant execute on function public.hag_admin_access_state() to authenticated;
