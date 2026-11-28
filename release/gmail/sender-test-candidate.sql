-- REVIEW ONLY. No approval, production migration, scheduler or delivery is performed here.
-- A single test reservation per connection generation; only the release operator
-- can approve an exact owner-controlled address. No marketing contacts are created.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create table hag_private.gmail_sender_test(
 generation bigint primary key, test_id uuid not null unique,
 recipient text not null check(recipient='jhawkins@heartlandathleticsgroup.com'),
 state text not null check(state in ('approved','claimed','accepted-not-delivered','ambiguous-hold-no-resend','authorization-required','provider-rejected')),
 approved_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
 claimed_at timestamptz, started_at timestamptz, finished_at timestamptz
);
alter table hag_private.gmail_sender_test enable row level security;
alter table hag_private.gmail_sender_test force row level security;
revoke all on hag_private.gmail_sender_test from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_gmail_release_operator;
create function hag_private.gmail_sender_test_approve(p_generation bigint,p_id uuid,p_recipient text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_id is null or p_recipient is distinct from 'jhawkins@heartlandathleticsgroup.com' then return false;end if;
 perform 1 from hag_private.gmail_connection where singleton and generation=p_generation and not enabled and credential is not null for update;
 if not found or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.hag_subscriptions) then return false;end if;
 insert into hag_private.gmail_sender_test(generation,test_id,recipient,state) values(p_generation,p_id,p_recipient,'approved') on conflict do nothing;
 return found;
end$$;
create function hag_private.gmail_sender_test_claim(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c hag_private.gmail_connection; t hag_private.gmail_sender_test;
begin
 select * into c from hag_private.gmail_connection where singleton for update;
 if c.enabled or c.credential is null or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.hag_subscriptions) then return null;end if;
 update hag_private.gmail_sender_test set state='claimed',claimed_at=clock_timestamp()
 where test_id=p_id and generation=c.generation and state='approved' and expires_at>clock_timestamp() returning * into t;
 if t.test_id is null then return null;end if;
 -- Ciphertext is restricted to the dispatch identity, never a public response.
 return jsonb_build_object('testId',t.test_id,'generation',t.generation,'recipient',t.recipient,'credential',c.credential,'keyVersion',c.key_version);
end$$;
-- Final dispatch fence; disconnect/rotation, expiration or replay denies the send.
create function hag_private.gmail_sender_test_start(p_id uuid,p_generation bigint)
returns boolean language plpgsql security definer set search_path='' as $
begin
 perform 1 from hag_private.gmail_connection where singleton and generation=p_generation and not enabled and credential is not null for update;
 if not found or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.hag_subscriptions) then return false;end if;
 update hag_private.gmail_sender_test set started_at=clock_timestamp()
 where test_id=p_id and generation=p_generation and state='claimed' and started_at is null and expires_at>clock_timestamp() and claimed_at>clock_timestamp()-interval '30 seconds';
 return found;
end$;
create function hag_private.gmail_sender_test_finish(p_id uuid,p_state text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_state is null or p_state not in ('accepted-not-delivered','ambiguous-hold-no-resend','authorization-required','provider-rejected') then return false;end if;
 update hag_private.gmail_sender_test set state=p_state,finished_at=clock_timestamp() where test_id=p_id and state='claimed' and (p_state<>'accepted-not-delivered' or started_at is not null);
 return found;
end$$;
revoke all on function hag_private.gmail_sender_test_approve(bigint,uuid,text),hag_private.gmail_sender_test_claim(uuid),hag_private.gmail_sender_test_start(uuid,bigint),hag_private.gmail_sender_test_finish(uuid,text) from public,anon,authenticated,service_role,hag_gmail_control,hag_gmail_dispatch,hag_subscription_runtime,hag_gmail_release_operator;
grant execute on function hag_private.gmail_sender_test_approve(bigint,uuid,text) to hag_gmail_release_operator;
grant execute on function hag_private.gmail_sender_test_claim(uuid),hag_private.gmail_sender_test_start(uuid,bigint),hag_private.gmail_sender_test_finish(uuid,text) to hag_gmail_dispatch;
commit;
