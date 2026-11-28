-- Review only; after SMS delivery candidate. No grants or activation.
-- Hard limit on reserved SMS segments, not a promise of exact carrier cost.
-- Fixed acknowledgment is two GSM-7 segments; marketing transport does not exist.
begin;
create table hag_private.sms_budget_limits(
 singleton boolean primary key check(singleton),
 daily_segments integer not null default 0 check(daily_segments between 0 and 10000),
 monthly_segments integer not null default 0 check(monthly_segments between 0 and 100000)
);
insert into hag_private.sms_budget_limits values(true,0,0);
create table hag_private.sms_budget_reservations(
 ticket uuid primary key references hag_private.sms_confirmation_outbox(ticket),
 local_day date not null,
 local_month date not null,
 segments integer not null check(segments=2)
);
alter table hag_private.sms_budget_limits enable row level security;
alter table hag_private.sms_budget_limits force row level security;
alter table hag_private.sms_budget_reservations enable row level security;
alter table hag_private.sms_budget_reservations force row level security;
revoke all on hag_private.sms_budget_limits,hag_private.sms_budget_reservations from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
create function hag_private.sms_reserve_ack_segments(p_ticket uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare lim hag_private.sms_budget_limits; d date; mon date;
begin
 -- One lock serializes quota use across every destination. No refunds after start,
 -- even when the provider response is ambiguous. No automatic retries.
 if not exists(select 1 from hag_private.sms_confirmation_outbox where ticket=p_ticket and state='reserved' and started_at is not null) then return false;end if;
 select * into lim from hag_private.sms_budget_limits where singleton for update;
 if lim.singleton is null then return false;end if;
 d:=(clock_timestamp() at time zone 'America/Chicago')::date;mon:=date_trunc('month',d::timestamp)::date;
 if exists(select 1 from hag_private.sms_budget_reservations where ticket=p_ticket) then return false;end if;
 if coalesce((select sum(segments) from hag_private.sms_budget_reservations where local_day=d),0)+2>lim.daily_segments or coalesce((select sum(segments) from hag_private.sms_budget_reservations where local_month=mon),0)+2>lim.monthly_segments then return false;end if;
 insert into hag_private.sms_budget_reservations(ticket,local_day,local_month,segments) values(p_ticket,d,mon,2);
 return true;
end$$;
revoke all on function hag_private.sms_reserve_ack_segments(uuid) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
create or replace function hag_private.sms_ack_start(p_ticket uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare m uuid; d text;
begin
 select q.method_id,c.destination into m,d from hag_private.sms_confirmation_outbox q join hag_private.hag_contact_methods c on c.id=q.method_id where q.ticket=p_ticket;
 if m is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||d,0));
 if not exists(select 1 from hag_private.sms_release_gate where singleton and enabled) or exists(select 1 from hag_private.sms_provider_blocks where destination=d) or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) or not exists(select 1 from hag_private.sport_preferences where method_id=m and status='active') then return false;end if;
 update hag_private.sms_confirmation_outbox set started_at=clock_timestamp()
 where ticket=p_ticket and state='reserved' and started_at is null and expires_at>clock_timestamp() and reserved_at>clock_timestamp()-interval '30 seconds';
 if not found then return false;end if;
 if not hag_private.sms_reserve_ack_segments(p_ticket) then
  update hag_private.sms_confirmation_outbox set state='held',finished_at=clock_timestamp() where ticket=p_ticket;
  return false;
 end if;
 return true;
end$$;

revoke all on function hag_private.sms_ack_start(uuid) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
commit;
