-- Additive migration AFTER E.9. Never rerun consolidated migration in production.
begin;
create table hag_private.subscription_welcome_once(method_id uuid primary key references hag_private.hag_contact_methods(id) on delete restrict, admitted_at timestamptz not null default clock_timestamp());
alter table hag_private.subscription_welcome_once enable row level security;
alter table hag_private.subscription_welcome_once force row level security;
revoke all on hag_private.subscription_welcome_once from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
create function hag_private.subscription_email_opt_in_welcome(p_id uuid,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $single$
declare claimed uuid; m uuid; changed integer; had_active boolean; raw text; j uuid:=gen_random_uuid();
begin
 if p_id is null or p_destination is null or not hag_private.subscription_destination_valid('email',p_destination) or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return;end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid email configuration'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if not exists(select 1 from hag_private.gmail_connection where singleton and enabled and credential is not null) then return; end if;
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then return; end if;
 if not hag_private.subscription_issue_budget('email',p_destination) then return;end if;
 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,'email') on conflict do nothing returning request_id into claimed;
 if claimed is null then return;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 select exists(select 1 from hag_private.hag_contact_methods cm join hag_private.hag_subscriptions s on s.contact_method_id=cm.id where cm.channel='email' and cm.destination=p_destination and s.status='active') into had_active;
 -- Existing active subscribers must use verified preferences to add topics.
 if had_active then return; end if;
 perform hag_private.stage_subscription_request(p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version);
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=p_destination;
 if m is null or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) then return;end if;
 update hag_private.hag_subscriptions s set status='active',email_opt_in_event_id=e.id
 from (select distinct on (subscription_id) id,subscription_id from hag_private.hag_consent_events where event_kind='requested' and source='website' and channel='email' and consent_version='draft-3c3-v1' and consent_text=hag_private.subscription_wording('email') order by subscription_id,occurred_at desc,id) e
 where s.contact_method_id=m and s.channel='email' and s.status='pending' and s.topic_code=any(p_topics) and e.subscription_id=s.id;
 get diagnostics changed=row_count;
 if changed=0 or had_active then return; end if;
 insert into hag_private.subscription_welcome_once(method_id) values(m) on conflict do nothing;
 if not found then return; end if;
 raw:=hag_private.subscription_new_token(m,'unsubscribe');
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose','welcome','token',raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
end $single$;
revoke all on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_control,hag_gmail_dispatch;
grant execute on function hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text) to hag_subscription_runtime;
revoke execute on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) from hag_subscription_runtime;
create or replace function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select coalesce(p_token ~ '^[0-9a-f]{64}$' and p_purpose in ('manage','unsubscribe','welcome') and exists(
 select 1 from hag_private.subscription_capabilities k join hag_private.hag_contact_methods m on m.id=k.method_id
 where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=case when p_purpose='welcome' then 'unsubscribe' else p_purpose end and k.used_at is null
 and k.expires_at>statement_timestamp()+interval '1 minute' and m.channel='email' and m.destination=p_destination
 and (p_purpose<>'welcome' or (exists(select 1 from hag_private.subscription_welcome_once w where w.method_id=m.id)
 and exists(select 1 from hag_private.hag_subscriptions s where s.contact_method_id=m.id and s.status='active')
 and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)))),false)
$elig$;
commit;
