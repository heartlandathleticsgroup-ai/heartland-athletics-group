-- DRAFT ONLY. Load after prior outbox regression suite in disposable PostgreSQL.
-- Separate consent evidence from verified ownership; never fabricate an email confirmation.
alter table hag_private.hag_subscriptions add column email_opt_in_event_id uuid;
alter table hag_private.hag_subscriptions add column email_opt_in_event_kind text generated always as ('requested'::text) stored;
alter table hag_private.hag_subscriptions add constraint subscription_email_opt_in_fk foreign key(email_opt_in_event_id,id,email_opt_in_event_kind) references hag_private.hag_consent_events(id,subscription_id,event_kind);
alter table hag_private.hag_subscriptions add constraint subscription_email_opt_in_channel check(email_opt_in_event_id is null or channel='email');
alter table hag_private.hag_subscriptions drop constraint hag_subscriptions_check;
alter table hag_private.hag_subscriptions add constraint subscription_active_evidence check(status<>'active' or confirmation_event_id is not null or (channel='email' and email_opt_in_event_id is not null));
create function hag_private.subscription_email_opt_in(p_id uuid,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns void language plpgsql volatile security definer set search_path='' as $single$
declare claimed uuid; m uuid;
begin
 if p_id is null or p_destination is null or p_destination !~ '^[a-z0-9._+%-]+@[a-z0-9.-]+[.]invalid$' or not hag_private.subscription_destination_valid('email',p_destination) or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-3c3-v1' or not hag_private.subscription_topics_valid(p_topics) or cardinality(p_topics)=0 then return;end if;
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
 -- No verification timestamp, confirmation event, capability, or outbox job.
end $single$;
revoke all on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) from public,anon,authenticated,service_role,hag_email_worker,hag_subscription_maintenance,hag_email_sim_event_ingestor;
grant execute on function hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text) to hag_subscription_runtime;
create or replace function hag_private.subscription_enqueue_email(p_id uuid,p_action text,p_name text,p_adult boolean,p_destination text,p_topics text[],p_consent boolean,p_version text,p_purpose text,p_key text,p_key_version text)
returns void language plpgsql volatile security definer set search_path='' as $fn$
declare raw text; j uuid:=gen_random_uuid();
begin
 if p_action is distinct from 'access' or p_purpose is null or p_purpose not in ('manage','unsubscribe') then return;end if;
 if p_destination is null or p_destination !~ '^[a-z0-9._+%-]+@[a-z0-9.-]+[.]invalid$' or p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version !~ '^[a-zA-Z0-9_-]{1,32}$' then raise exception 'Invalid isolated email configuration';end if;
 -- Serialize admission only; bounded backlog, no token created when full.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 if (select count(*) from hag_private.subscription_email_outbox where state in ('queued','retry','leased'))>=200 then return; end if;
 raw:=hag_private.subscription_gateway_issue(p_id,p_action,p_name,p_adult,'email',p_destination,p_topics,p_consent,p_version,p_purpose);
 if raw is null then return; end if;
 insert into hag_private.subscription_email_outbox(id,request_id,payload,key_version,deadline)
 values(j,p_id,extensions.pgp_sym_encrypt(jsonb_build_object('destination',p_destination,'purpose',p_purpose,'token',raw)::text,p_key,'cipher-algo=aes256,compress-algo=0'),p_key_version,clock_timestamp()+interval '15 minutes');
end $fn$;

-- Disable any historical draft email confirmation capabilities and dispatch attempts.
update hag_private.subscription_capabilities k set used_at=clock_timestamp() from hag_private.hag_contact_methods m where k.method_id=m.id and m.channel='email' and k.purpose='confirm' and k.used_at is null;
create or replace function hag_private.subscription_email_delivery_eligible(p_token text,p_destination text,p_purpose text)
returns boolean language sql stable security definer set search_path='' as $elig$
 select coalesce(p_token ~ '^[0-9a-f]{64}$' and p_purpose in ('manage','unsubscribe') and exists(
 select 1 from hag_private.subscription_capabilities k
 join hag_private.hag_contact_methods m on m.id=k.method_id
 where k.token_hash=extensions.digest(p_token,'sha256') and k.purpose=p_purpose
 and k.used_at is null and k.expires_at>statement_timestamp()+interval '1 minute'
 and m.channel='email' and m.destination=p_destination
 and (p_purpose<>'confirm' or (
 not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active)
 and exists(select 1 from hag_private.hag_subscriptions s join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose where s.contact_method_id=m.id and s.id=any(k.snapshot) and s.status='pending' and t.active
 and exists(select 1 from hag_private.hag_consent_events e where e.subscription_id=s.id and e.event_kind='requested' and e.consent_version='draft-3c3-v1' and e.consent_text=hag_private.subscription_wording(m.channel)))
 ))),false)
$elig$;
