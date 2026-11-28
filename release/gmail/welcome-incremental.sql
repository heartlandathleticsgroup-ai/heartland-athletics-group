-- Apply only after verified E.9 schema exists, while sender and runtime remain disabled.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $preflight$
begin
 if to_regclass('hag_private.gmail_connection') is null or to_regclass('hag_private.subscription_email_outbox') is null or to_regprocedure('hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text)') is null then raise exception 'E.9 baseline missing';end if;
 if exists(select 1 from hag_private.gmail_connection where enabled or credential is not null) or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.hag_subscriptions) then raise exception 'Expected disabled empty subscriber baseline; review separately';end if;
 if exists(select 1 from pg_roles where rolname in ('hag_gmail_control_login','hag_gmail_dispatch_login','hag_subscription_gateway_login') and rolcanlogin) then raise exception 'Runtime logins must remain disabled';end if;
end $preflight$;
-- Public subscriber welcome batch: no hosted execution; keep deployment and send locks.
-- One durable marker per email contact method, surviving outbox cleanup.
alter table hag_private.hag_contact_methods add column email_welcome_queued_at timestamptz;
alter table hag_private.hag_contact_methods add constraint email_welcome_channel check(email_welcome_queued_at is null or channel='email');

create function hag_private.subscription_email_opt_in_welcome(p_id uuid,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $welcome$
declare claimed uuid; m uuid; manage_raw text; unsubscribe_raw text; j uuid:=gen_random_uuid(); n int;
begin
 if p_id is null or not hag_private.subscription_destination_valid('email',p_destination) or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return;end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid email configuration';end if;
 if not exists(select 1 from hag_private.gmail_connection where singleton and enabled and credential is not null) then raise exception 'Delivery not enabled';end if;
 -- Same admission and issuance lock order as secure-link requests.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then raise exception 'Admission unavailable';end if;
 if not hag_private.subscription_issue_budget('email',p_destination) then return;end if;
 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,'email') on conflict do nothing returning request_id into claimed;
 if claimed is null then return;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 perform hag_private.stage_subscription_request(p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return;end if;
 update hag_private.hag_subscriptions s set status='active',email_opt_in_event_id=e.id
 from (select distinct on (subscription_id) id,subscription_id from hag_private.hag_consent_events where event_kind='requested' and source='website' and channel='email' and consent_version='draft-3c3-v1' and consent_text=hag_private.subscription_wording('email') order by subscription_id,occurred_at desc,id) e
 where s.contact_method_id=m and s.channel='email' and s.status='pending' and s.topic_code=any(p_topics) and e.subscription_id=s.id;
 get diagnostics n=row_count;
 if n=0 then return;end if;
 update hag_private.hag_contact_methods set email_welcome_queued_at=clock_timestamp() where id=m and email_welcome_queued_at is null;
 if not found then return;end if;
 manage_raw:=hag_private.subscription_new_token(m,'manage');
 unsubscribe_raw:=hag_private.subscription_new_token(m,'unsubscribe');
 -- Bind both capabilities into the existing encrypted payload and dispatch digest.
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose','welcome','token',manage_raw||':'||unsubscribe_raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
 -- No ownership verification or confirmation event is fabricated. Transaction failure rolls back consent, marker, links and queue.
end $welcome$;
revoke all on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) from public,anon,authenticated,service_role,hag_email_worker,hag_subscription_maintenance,hag_email_sim_event_ingestor,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) to hag_subscription_runtime;
revoke execute on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) from hag_subscription_runtime;
-- Both links must remain usable, and the welcome must be cancelled if the email is suppressed before dispatch.
create or replace function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select case when p_purpose='welcome' then coalesce(p_token ~ '^[0-9a-f]{64}:[0-9a-f]{64}$' and exists(
  select 1 from hag_private.hag_contact_methods m
  join hag_private.subscription_capabilities k on k.method_id=m.id and k.purpose='manage' and k.token_hash=extensions.digest(split_part(p_token,':',1),'sha256')
  join hag_private.subscription_capabilities u on u.method_id=m.id and u.purpose='unsubscribe' and u.token_hash=extensions.digest(split_part(p_token,':',2),'sha256')
  where m.channel='email' and m.destination=p_destination and k.used_at is null and u.used_at is null
  and k.expires_at>statement_timestamp()+interval '1 minute' and u.expires_at>statement_timestamp()+interval '1 minute'
  and exists(select 1 from hag_private.hag_subscriptions s where s.contact_method_id=m.id and s.channel='email' and s.status='active')
  and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)),false)
 else coalesce(p_token ~ '^[0-9a-f]{64}$' and p_purpose in ('manage','unsubscribe') and exists(
  select 1 from hag_private.subscription_capabilities k join hag_private.hag_contact_methods m on m.id=k.method_id
  where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=p_purpose and k.used_at is null
  and k.expires_at>statement_timestamp()+interval '1 minute' and m.channel='email' and m.destination=p_destination),false) end
$elig$;
commit;
