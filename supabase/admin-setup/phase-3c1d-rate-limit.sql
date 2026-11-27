-- Dedicated global authentication gateway budget, independent of spoofable client headers.
-- Fixed windows: 10 candidate assertions/minute and 60/hour across all instances.
-- Fail closed if the RPC is unavailable; no credential approvals or session changes.
create table hag_private.hag_passkey_rate_limit (
  singleton boolean primary key default true check (singleton),
  minute_start timestamptz not null,
  hour_start timestamptz not null,
  minute_count integer not null check (minute_count between 0 and 10),
  hour_count integer not null check (hour_count between 0 and 60)
);
alter table hag_private.hag_passkey_rate_limit enable row level security;
alter table hag_private.hag_passkey_rate_limit force row level security;
revoke all on hag_private.hag_passkey_rate_limit from public,anon,authenticated,service_role;
create function hag_private.take_passkey_budget() returns boolean
language plpgsql volatile security definer set search_path='' as $fn$
declare t timestamptz := clock_timestamp(); m timestamptz := date_trunc('minute',t); h timestamptz := date_trunc('hour',t);
begin
  insert into hag_private.hag_passkey_rate_limit as l(singleton,minute_start,hour_start,minute_count,hour_count)
  values(true,m,h,1,1)
  on conflict(singleton) do update set
    minute_count=case when l.minute_start < m then 1 else l.minute_count+1 end,
    hour_count=case when l.hour_start < h then 1 else l.hour_count+1 end,
    minute_start=greatest(l.minute_start,m),hour_start=greatest(l.hour_start,h)
  where (l.minute_start < m or l.minute_count < 10)
    and (l.hour_start < h or l.hour_count < 60);
  return found;
end $fn$;
revoke all on function hag_private.take_passkey_budget() from public,anon,authenticated,service_role;
grant usage on schema hag_private to service_role;
grant execute on function hag_private.take_passkey_budget() to service_role;
create function public.hag_take_passkey_budget() returns boolean
language sql volatile security invoker set search_path='' as $fn$
select hag_private.take_passkey_budget()
$fn$;
revoke all on function public.hag_take_passkey_budget() from public,anon,authenticated,service_role;
grant execute on function public.hag_take_passkey_budget() to service_role;
