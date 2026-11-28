-- Review-only incremental candidate; no hosted execution or provider delivery.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
do $$begin
 if to_regprocedure('hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text)') is null or exists(select 1 from hag_private.gmail_connection where enabled or credential is not null) or exists(select 1 from hag_private.hag_subscriptions) or exists(select 1 from hag_private.subscription_email_outbox) then raise exception 'Sport preferences require disabled empty welcome baseline';end if;
end$$;
create table hag_private.sport_catalog(
 code text primary key check(code ~ '^[a-z][a-z0-9-]{0,39}$' and code <> 'all-sports'),
 label text not null check(length(btrim(label)) between 1 and 80),
 active boolean not null default true
);
insert into hag_private.sport_catalog(code,label) values ('basketball','Basketball'),('volleyball','Volleyball'),('baseball','Baseball'),('softball','Softball'),('football','Football'),('soccer','Soccer');
create table hag_private.sport_update_types(
 code text primary key,
 label text not null,
 legacy_topic text not null references hag_private.hag_topics(code),
 scope text not null check(scope in ('general','basketball','sport','either'))
);
insert into hag_private.sport_update_types values
 ('general','General H.A.G. announcements','hag-announcements','general'),
 ('enforcers','Heartland Enforcers Basketball Club','enforcers-updates','basketball'),
 ('gus-macker','Gus Macker – Quincy','gus-macker-local','basketball'),
 ('tryouts-registration','Tryouts and registrations','enforcers-tryouts','sport'),
 ('camps-clinics','Camps and clinics','camps-clinics','sport'),
 ('tournaments-events','Tournaments and events','tournaments-events','sport'),
 ('recreational-leagues','Youth recreational leagues','tournaments-events','sport'),
 ('sponsorship','Sponsorship opportunities','sponsorship-updates','either'),
 ('volunteer','Volunteer opportunities','volunteer-updates','either');
create table hag_private.sport_preferences(
 method_id uuid primary key,
 channel text not null,
 sports text[] not null,
 update_types text[] not null,
 status text not null check(status in ('active','pending','withdrawn')),
 revision bigint not null default 1,
 updated_at timestamptz not null default clock_timestamp(),
 foreign key(method_id,channel) references hag_private.hag_contact_methods(id,channel) on delete restrict
);
create table hag_private.sport_consent_events(
 id uuid primary key default gen_random_uuid(),
 method_id uuid not null references hag_private.sport_preferences(method_id) on delete restrict,
 revision bigint not null,
 channel text not null check(channel in ('email','sms')),
 sports text[] not null,
 update_types text[] not null,
 event_kind text not null check(event_kind in ('requested','withdrawn','confirmed')),
 version text not null,
 wording text not null,
 occurred_at timestamptz not null default clock_timestamp()
);
-- Campaign reservations are review-only, not a sending queue. Unique campaign/method prevents duplicate reservation.
create table hag_private.sport_campaigns(
 id uuid primary key,
 sport_code text references hag_private.sport_catalog(code),
 update_type text not null references hag_private.sport_update_types(code),
 channel text not null check(channel in ('email','sms')),
 created_at timestamptz not null default clock_timestamp()
);
create table hag_private.sport_campaign_recipients(
 campaign_id uuid not null references hag_private.sport_campaigns(id),
 method_id uuid not null references hag_private.sport_preferences(method_id),
 primary key(campaign_id,method_id)
);
do $$declare t text;begin
 foreach t in array array['sport_catalog','sport_update_types','sport_preferences','sport_consent_events','sport_campaigns','sport_campaign_recipients'] loop
 execute format('alter table hag_private.%I enable row level security',t);
 execute format('alter table hag_private.%I force row level security',t);
 execute format('revoke all on hag_private.%I from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_control,hag_gmail_dispatch,hag_email_worker',t);
 end loop;
end$$;
create function hag_private.sport_selection_valid(s text[],u text[])
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(s is not null and u is not null and cardinality(s)<=40 and cardinality(u) between 1 and 9
 and array_position(s,null) is null and array_position(u,null) is null
 and cardinality(s)=(select count(distinct x) from unnest(s) x) and cardinality(u)=(select count(distinct x) from unnest(u) x)
 and (not ('all-sports'=any(s)) or cardinality(s)=1)
 and not exists(select 1 from unnest(s) x where x<>'all-sports' and not exists(select 1 from hag_private.sport_catalog c where c.code=x and c.active))
 and not exists(select 1 from unnest(u) x where not exists(select 1 from hag_private.sport_update_types t where t.code=x))
 and (cardinality(s)>0 or not exists(select 1 from hag_private.sport_update_types t where t.code=any(u) and t.scope in ('sport','basketball')))
 and (not (u && array['enforcers','gus-macker']) or s && array['basketball','all-sports']),false)
$$;
create function hag_private.sport_wording(c text) returns text language sql immutable set search_path='' as $$
 select hag_private.subscription_wording(c)||' I choose the listed sports and types of updates for this channel. Sport-specific updates must match both choices. All current and future sports includes sports added later only if selected.'
$$;
-- Internal only. Caller must have already established the method through the existing consent workflow.
-- First registration does not replace or expand existing preferences on an unverified repeat submission.
create function hag_private.sport_initial(p_method uuid,p_sports text[],p_updates text[],p_adult boolean,p_consent boolean,p_version text)
returns boolean language plpgsql volatile security invoker set search_path='' as $$
declare m hag_private.hag_contact_methods; st text;
begin
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-sports-v2' or not hag_private.sport_selection_valid(p_sports,p_updates) then return false;end if;
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
-- Atomic first email opt-in and sport record. Legacy queue and consent stay in same transaction.
-- No grant yet: release runtime must be upgraded and provider verified before exposing this entry point.
create function hag_private.sport_email_signup(p_id uuid,p_name text,p_adult boolean,p_destination text,p_sports text[],p_updates text[],p_consent boolean,p_version text,p_key text,p_key_version text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare legacy text[]; m uuid;
begin
 if p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-sports-v2' or not hag_private.sport_selection_valid(p_sports,p_updates) or not hag_private.subscription_destination_valid('email',p_destination) then return false;end if;
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
-- Secure manage/edit uses the same one-use hashed capabilities, destination lock and budgets.
create function hag_private.sport_manage(p_raw text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare cap hag_private.subscription_capabilities; p hag_private.sport_preferences; suppressed boolean;
begin
 if not hag_private.subscription_allow('redeem-global','all',1,120) then return null;end if;
 cap:=hag_private.subscription_take(p_raw,'manage');
 if cap.method_id is null then return null;end if;
 select * into p from hag_private.sport_preferences where method_id=cap.method_id;
 if p.method_id is null then return null;end if;
 select exists(select 1 from hag_private.hag_suppressions where contact_method_id=p.method_id and active) into suppressed;
 update hag_private.hag_contact_methods set verified_at=coalesce(verified_at,clock_timestamp()) where id=p.method_id;
 return jsonb_build_object('channel',p.channel,'sports',p.sports,'updates',p.update_types,'status',p.status,'suppressed',suppressed,'editToken',hag_private.subscription_new_token(p.method_id,'edit'));
end$$;
create function hag_private.sport_edit(p_raw text,p_sports text[],p_updates text[],p_adult boolean,p_consent boolean,p_version text)
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
 if expanding and (p.channel='sms' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from 'draft-sports-v2' or exists(select 1 from hag_private.hag_suppressions where contact_method_id=p.method_id and active)) then return false;end if;
 new_status:=case when cardinality(p_updates)=0 then 'withdrawn' when expanding then 'active' else p.status end;
 update hag_private.sport_preferences set sports=p_sports,update_types=p_updates,status=new_status,revision=revision+1,updated_at=clock_timestamp() where method_id=p.method_id returning * into p;
 insert into hag_private.sport_consent_events(method_id,revision,channel,sports,update_types,event_kind,version,wording) values(p.method_id,p.revision,p.channel,p.sports,p.update_types,case when expanding then 'requested' else 'withdrawn' end,'draft-sports-v2',case when expanding then hag_private.sport_wording(p.channel) else 'Verified preference withdrawal or reduction.' end);
 update hag_private.subscription_capabilities set used_at=clock_timestamp() where method_id=p.method_id and used_at is null and purpose in ('manage','edit');
 return true;
end$$;
create function hag_private.sport_target_valid(p_sport text,p_update text,p_channel text)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(p_channel in ('email','sms') and exists(select 1 from hag_private.sport_update_types t where t.code=p_update and
 case when p_sport is null then t.scope in ('general','either') else t.scope in ('sport','either') or t.scope='basketball' and p_sport='basketball' end)
 and (p_sport is null or exists(select 1 from hag_private.sport_catalog where code=p_sport and active)),false)
$$;
create function hag_private.sport_audience(p_sport text,p_update text,p_channel text)
returns table(method_id uuid) language sql stable security invoker set search_path='' as $$
 select p.method_id from hag_private.sport_preferences p join hag_private.hag_contact_methods m on m.id=p.method_id
 where hag_private.sport_target_valid(p_sport,p_update,p_channel) and p.channel=p_channel and p.status='active'
 and p_update=any(p.update_types) and (p_sport is null or p_sport=any(p.sports) or 'all-sports'=any(p.sports))
 and (p_channel='email' or m.verified_at is not null)
 and exists(select 1 from hag_private.hag_subscriptions s where s.contact_method_id=p.method_id and s.status='active')
 and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=p.method_id and x.active)
$$;
-- Reserve synthetic review recipients only. Recheck audience at every eventual send; this table is never read by Gmail worker.
create function hag_private.sport_reserve_review(p_id uuid,p_sport text,p_update text,p_channel text)
returns bigint language plpgsql volatile security invoker set search_path='' as $$
begin
 if p_id is null or not hag_private.sport_target_valid(p_sport,p_update,p_channel) then raise exception 'Invalid audience';end if;
 insert into hag_private.sport_campaigns(id,sport_code,update_type,channel) values(p_id,p_sport,p_update,p_channel) on conflict do nothing;
 if not exists(select 1 from hag_private.sport_campaigns where id=p_id and sport_code is not distinct from p_sport and update_type=p_update and channel=p_channel) then raise exception 'Campaign target immutable';end if;
 insert into hag_private.sport_campaign_recipients select p_id,method_id from hag_private.sport_audience(p_sport,p_update,p_channel) on conflict do nothing;
 return (select count(*) from hag_private.sport_campaign_recipients r join hag_private.sport_audience(p_sport,p_update,p_channel) a using(method_id) where r.campaign_id=p_id);
end$$;
-- CMS RPCs return no addresses or identifiers; require existing authorized admin and recent step-up.
create function hag_private.sport_admin(p_action text,p_code text default null,p_label text default null,p_active boolean default null,p_update text default null,p_channel text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
 if hag_private.gmail_admin_proof() is null then raise exception 'Access unavailable';end if;
 if p_action='catalog' then return coalesce((select jsonb_agg(jsonb_build_object('code',code,'label',label,'active',active) order by label) from hag_private.sport_catalog),'[]'::jsonb);end if;
 if p_action='save' then
  if p_code is null or p_code !~ '^[a-z][a-z0-9-]{0,39}$' or p_code='all-sports' or p_label is null or length(btrim(p_label)) not between 1 and 80 or p_label ~ '[[:cntrl:]]' or p_active is null then raise exception 'Invalid sport';end if;
  if not exists(select 1 from hag_private.sport_catalog where code=p_code) and (select count(*) from hag_private.sport_catalog)>=40 then raise exception 'Catalog limit';end if;
  insert into hag_private.sport_catalog(code,label,active) values(p_code,btrim(p_label),p_active) on conflict(code) do update set label=excluded.label,active=excluded.active;
  return jsonb_build_object('ok',true);
 end if;
 if p_action='count' then
  if not hag_private.sport_target_valid(p_code,p_update,p_channel) then raise exception 'Invalid audience';end if;
  return jsonb_build_object('count',(select count(*) from hag_private.sport_audience(p_code,p_update,p_channel)));
 end if;
 raise exception 'Invalid action';
end$$;
-- Every function is private and denied by default; even the CMS route remains ungranted until release review.
do $$declare r record;begin
 for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='hag_private' and p.proname like 'sport_%' loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_control,hag_gmail_dispatch,hag_email_worker',r.sig);
 end loop;
end$$;
commit;
