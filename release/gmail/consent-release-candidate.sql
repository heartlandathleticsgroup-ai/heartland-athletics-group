-- REVIEW-ONLY candidate; apply only after tested release approval. Prior migrations are immutable.
-- No subscriber or consent rows may exist at the version cutover. Connected Gmail is preserved.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $gate$ begin
 if exists(select 1 from hag_private.gmail_connection where enabled) or exists(select 1 from hag_private.subscription_email_outbox) or exists(select 1 from hag_private.sport_preferences) or exists(select 1 from hag_private.sport_consent_events) or exists(select 1 from hag_private.hag_subscriptions) then raise exception 'Consent cutover requires empty subscriber baseline and disabled delivery'; end if;
end $gate$;
create or replace function hag_private.sport_initial(p_method uuid,p_sports text[],p_updates text[],p_adult boolean,p_consent boolean,p_version text)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare m hag_private.hag_contact_methods; st text;
begin
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'hag-sports-v1' or not hag_private.sport_selection_valid(p_sports,p_updates) then return false;end if;
 select * into m from hag_private.hag_contact_methods where id=p_method;
 if m.id is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||m.channel||':'||m.destination,0));
 if exists(select 1 from hag_private.hag_suppressions where contact_method_id=m.id and active) or not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m.id and status in ('active','pending')) then return false;end if;
 st:=case when m.channel='sms' then 'pending' else 'active' end;
 if m.channel='email' and not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=m.id and status='active') then return false;end if;
 insert into hag_private.sport_preferences(method_id,channel,sports,update_types,status) values(m.id,m.channel,p_sports,p_updates,st) on conflict do nothing;
 if not found then return false;end if;
 insert into hag_private.sport_consent_events(method_id,revision,channel,sports,update_types,event_kind,version,wording) values(m.id,1,m.channel,p_sports,p_updates,'requested',p_version,hag_private.sport_wording(m.channel));
 return true;
end$$;

create or replace function hag_private.sport_email_signup(p_id uuid,p_name text,p_adult boolean,p_destination text,p_sports text[],p_updates text[],p_consent boolean,p_version text,p_key text,p_key_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare legacy text[]; m uuid;
begin
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'hag-sports-v1' or not hag_private.sport_selection_valid(p_sports,p_updates) or not hag_private.subscription_destination_valid('email',p_destination) then return false;end if;
 -- Consistent lock ordering with welcome. A second request cannot widen preferences.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-email-admission',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:email:'||p_destination,0));
 if exists(select 1 from hag_private.hag_contact_methods where channel='email' and destination=p_destination) then return false;end if;
 select array_agg(distinct legacy_topic) into legacy from hag_private.sport_update_types where code=any(p_updates);
 perform hag_private.subscription_email_opt_in_welcome(p_id,p_name,p_adult,p_destination,legacy,p_consent,'draft-3c3-v1',p_key,p_key_version);
 select id into m from hag_private.hag_contact_methods where channel='email' and destination=p_destination;
 if m is null then return false;end if;
 if not hag_private.sport_initial(m,p_sports,p_updates,p_adult,p_consent,p_version) then raise exception 'Sport consent atomicity failed';end if;
 return true;
end$$;

create or replace function hag_private.sport_edit(p_raw text,p_sports text[],p_updates text[],p_adult boolean,p_consent boolean,p_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare cap hag_private.subscription_capabilities; p hag_private.sport_preferences; expanding boolean; new_status text;
begin
 if not hag_private.subscription_allow('redeem-global','all',1,120) then return false;end if;
 if p_sports is null or p_updates is null or not (hag_private.sport_selection_valid(p_sports,p_updates) or (cardinality(p_sports)=0 and cardinality(p_updates)=0)) then return false;end if;
 cap:=hag_private.subscription_take(p_raw,'edit');
 if cap.method_id is null then return false;end if;
 select * into p from hag_private.sport_preferences where method_id=cap.method_id for update;
 if p.method_id is null then return false;end if;
 expanding:=not(p_sports <@ p.sports and p_updates <@ p.update_types) or p.status='withdrawn' and cardinality(p_updates)>0;
 -- SMS expansion awaits provider-specific confirmation. No manage link alone can confirm it.
 if expanding and (p.channel='sms' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'hag-sports-v1' or exists(select 1 from hag_private.hag_suppressions where contact_method_id=p.method_id and active)) then return false;end if;
 new_status:=case when cardinality(p_updates)=0 then 'withdrawn' when expanding then 'active' else p.status end;
 update hag_private.sport_preferences set sports=p_sports,update_types=p_updates,status=new_status,revision=revision+1,updated_at=clock_timestamp() where method_id=p.method_id returning * into p;
 insert into hag_private.sport_consent_events(method_id,revision,channel,sports,update_types,event_kind,version,wording) values(p.method_id,p.revision,p.channel,p.sports,p.update_types,case when expanding then 'requested' else 'withdrawn' end,'hag-sports-v1',case when expanding then hag_private.sport_wording(p.channel) else 'Verified preference withdrawal or reduction.' end);
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=p.method_id and used_at is null and purpose in ('manage','edit');
 return true;
end$$;

create or replace function hag_private.sport_suppression_withdraw()
returns trigger language plpgsql security definer set search_path='' as $$
declare p hag_private.sport_preferences;
begin
 if new.active then
 update hag_private.sport_preferences set status='withdrawn',revision=revision+1,updated_at=clock_timestamp() where method_id=new.contact_method_id and status<>'withdrawn' returning * into p;
 if p.method_id is not null then
 insert into hag_private.sport_consent_events(method_id,revision,channel,sports,update_types,event_kind,version,wording) values(p.method_id,p.revision,p.channel,p.sports,p.update_types,'withdrawn','hag-sports-v1','Channel suppression applied.');
 end if;
 end if;
 return new;
end$$;

create or replace function hag_private.sport_sms_signup(p_id uuid,p_name text,p_adult boolean,p_destination text,p_sports text[],p_updates text[],p_consent boolean,p_version text)
returns text language plpgsql volatile security invoker set search_path='' as $$
declare legacy text[]; m uuid; raw text; claim uuid;
begin
 if p_id is null or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'hag-sports-v1' or not hag_private.sport_selection_valid(p_sports,p_updates) or not hag_private.subscription_destination_valid('sms',p_destination) then return null;end if;
 if not hag_private.subscription_issue_budget('sms',p_destination) then return null;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||p_destination,0));
 if exists(select 1 from hag_private.hag_contact_methods where channel='sms' and destination=p_destination) then return null;end if;
 insert into hag_private.subscription_issue_keys(request_id,channel) values(p_id,'sms') on conflict do nothing returning request_id into claim;
 if claim is null then return null;end if;
 select array_agg(distinct legacy_topic) into legacy from hag_private.sport_update_types where code=any(p_updates);
 raw:=hag_private.subscription_request(p_name,p_adult,'sms',p_destination,legacy,p_consent,'draft-3c3-v1');
 if raw is null then return null;end if;
 select id into m from hag_private.hag_contact_methods where channel='sms' and destination=p_destination;
 if not hag_private.sport_initial(m,p_sports,p_updates,p_adult,p_consent,p_version) then raise exception 'Sport SMS atomicity failed';end if;
 insert into hag_private.sport_sms_confirmation values(extensions.digest(raw,'sha256'),m,1);
 -- Raw capability is for future verified provider delivery only, never a public response.
 return raw;
end$$;

create or replace function hag_private.sport_sms_confirm(p_raw text)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare p hag_private.sport_preferences; d text; rev bigint; outcome jsonb;
begin
 if p_raw is null or p_raw !~ '^[a-f0-9]{64}$' then return false;end if;
 select x.method_id,x.revision,m.destination into p.method_id,rev,d from hag_private.sport_sms_confirmation x join hag_private.hag_contact_methods m on m.id=x.method_id where x.token_hash=extensions.digest(p_raw,'sha256');
 if p.method_id is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||d,0));
 select * into p from hag_private.sport_preferences where method_id=p.method_id for update;
 if p.channel<>'sms' or p.revision<>rev or p.status<>'pending' or exists(select 1 from hag_private.hag_suppressions where contact_method_id=p.method_id and active) then return false;end if;
 outcome:=hag_private.subscription_redeem(p_raw,'confirm');
 if outcome->>'ok' is distinct from 'true' then return false;end if;
 update hag_private.sport_preferences set status='active',revision=revision+1,updated_at=clock_timestamp() where method_id=p.method_id returning * into p;
 insert into hag_private.sport_consent_events(method_id,revision,channel,sports,update_types,event_kind,version,wording) values(p.method_id,p.revision,p.channel,p.sports,p.update_types,'confirmed','hag-sports-v1',hag_private.sport_wording('sms'));
 delete from hag_private.sport_sms_confirmation where token_hash=extensions.digest(p_raw,'sha256');
 return true;
end$$;
-- CREATE OR REPLACE retains existing grants. Verify no broad execution or SMS runtime grant.
do $gate$ begin
 if has_function_privilege('anon','hag_private.sport_email_signup(uuid,text,boolean,text,text[],text[],boolean,text,text,text)','execute') or has_function_privilege('authenticated','hag_private.sport_email_signup(uuid,text,boolean,text,text[],text[],boolean,text,text,text)','execute') or has_function_privilege('hag_subscription_runtime','hag_private.sport_sms_signup(uuid,text,boolean,text,text[],text[],boolean,text)','execute') or not has_function_privilege('hag_subscription_runtime','hag_private.sport_email_signup(uuid,text,boolean,text,text[],text[],boolean,text,text,text)','execute') then raise exception 'Unexpected release grants';end if;
end $gate$;
commit;
