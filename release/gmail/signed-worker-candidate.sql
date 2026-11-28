-- Review only. No extension installation, cron job, secret storage, runtime grant or network call.
begin;
create table hag_private.gmail_worker_nonces(
 nonce uuid primary key, issued_at timestamptz not null, consumed_at timestamptz not null default clock_timestamp()
);
alter table hag_private.gmail_worker_nonces enable row level security;
alter table hag_private.gmail_worker_nonces force row level security;
revoke all on hag_private.gmail_worker_nonces from public,anon,authenticated,service_role,hag_gmail_dispatch,hag_gmail_control,hag_subscription_runtime;
create function hag_private.gmail_worker_consume(p_nonce uuid,p_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare issued timestamptz;
begin
 if p_nonce is null or p_epoch is null or p_epoch not between 1000000000 and 9999999999 then return false;end if;
 issued:=to_timestamp(p_epoch);
 if issued>clock_timestamp()+interval '5 seconds' or issued<clock_timestamp()-interval '60 seconds' or not exists(select 1 from hag_private.gmail_connection where enabled and credential is not null) then return false;end if;
 insert into hag_private.gmail_worker_nonces(nonce,issued_at) values(p_nonce,issued) on conflict do nothing;
 return found;
end$$;
revoke all on function hag_private.gmail_worker_consume(uuid,bigint) from public,anon,authenticated,service_role,hag_gmail_dispatch,hag_gmail_control,hag_subscription_runtime;
-- Pure signer for a future narrowly authorized Vault-backed cron wrapper.
-- It does not schedule or enqueue anything and is not callable by runtime roles.
create function hag_private.gmail_worker_sign(p_key text,p_epoch bigint,p_nonce uuid)
returns text language plpgsql immutable security invoker set search_path='' as $
begin
 if p_key is null or p_key !~ '^[a-f0-9]{64}
 or p_epoch is null or p_epoch not between 1000000000 and 9999999999 or p_nonce is null then return null;end if;
 return encode(extensions.hmac(convert_to('hag-email-worker-v1'||chr(10)||'POST'||chr(10)||'https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-worker'||chr(10)||p_epoch::text||chr(10)||p_nonce::text,'UTF8'),decode(p_key,'hex'),'sha256'),'hex');
end$;
revoke all on function hag_private.gmail_worker_sign(text,bigint,uuid) from public,anon,authenticated,service_role,hag_gmail_dispatch,hag_gmail_control,hag_subscription_runtime;
commit;
