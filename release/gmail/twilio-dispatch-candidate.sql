-- Review-only acknowledgment dispatch controls. No runtime grants, account or credentials.
begin;
create table hag_private.sms_release_gate(singleton boolean primary key check(singleton),enabled boolean not null default false);
insert into hag_private.sms_release_gate values(true,false);
alter table hag_private.sms_release_gate enable row level security;
alter table hag_private.sms_release_gate force row level security;
revoke all on hag_private.sms_release_gate from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
alter table hag_private.sms_confirmation_outbox add column started_at timestamptz,add column provider_sid text unique check(provider_sid ~ '^SM[0-9A-Fa-f]{32}$');
create function hag_private.sms_ack_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare j hag_private.sms_confirmation_outbox; d text;
begin
 if not exists(select 1 from hag_private.sms_release_gate where singleton and enabled) then return null;end if;
 -- One acknowledgment per minute, and never a marketing campaign.
 if not hag_private.subscription_allow('sms-ack-minute','all',1,1) then return null;end if;
 select q.* into j from hag_private.sms_confirmation_outbox q
 join hag_private.hag_contact_methods m on m.id=q.method_id
 join hag_private.sport_preferences p on p.method_id=m.id
 where q.state='queued' and q.expires_at>clock_timestamp() and m.channel='sms' and m.verified_at is not null and p.status='active'
 and not exists(select 1 from hag_private.hag_suppressions s where s.contact_method_id=m.id and s.active)
 and not exists(select 1 from hag_private.sms_provider_blocks b where b.destination=m.destination)
 order by q.created_at limit 1 for update of q skip locked;
 if j.method_id is null then return null;end if;
 select destination into d from hag_private.hag_contact_methods where id=j.method_id;
 update hag_private.sms_confirmation_outbox set state='reserved',ticket=gen_random_uuid(),reserved_at=clock_timestamp() where method_id=j.method_id returning * into j;
 return jsonb_build_object('ticket',j.ticket,'destination',d);
end$$;
create function hag_private.sms_ack_start(p_ticket uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare m uuid; d text;
begin
 select q.method_id,c.destination into m,d from hag_private.sms_confirmation_outbox q join hag_private.hag_contact_methods c on c.id=q.method_id where q.ticket=p_ticket;
 if m is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||d,0));
 if not exists(select 1 from hag_private.sms_release_gate where singleton and enabled) or exists(select 1 from hag_private.sms_provider_blocks where destination=d) or exists(select 1 from hag_private.hag_suppressions where contact_method_id=m and active) or not exists(select 1 from hag_private.sport_preferences where method_id=m and status='active') then return false;end if;
 update hag_private.sms_confirmation_outbox set started_at=clock_timestamp()
 where ticket=p_ticket and state='reserved' and started_at is null and expires_at>clock_timestamp() and reserved_at>clock_timestamp()-interval '30 seconds';
 return found;
end$$;
create function hag_private.sms_ack_finish(p_ticket uuid,p_outcome text,p_sid text) returns boolean language plpgsql security definer set search_path='' as $$
declare m uuid; d text;
begin
 if p_outcome is null or p_outcome not in ('accepted','held','cancelled','provider-blocked') or (p_outcome='accepted' and (p_sid is null or p_sid !~ '^SM[0-9A-Fa-f]{32}$')) or (p_outcome<>'accepted' and p_sid is not null) then return false;end if;
 select q.method_id,c.destination into m,d from hag_private.sms_confirmation_outbox q join hag_private.hag_contact_methods c on c.id=q.method_id where q.ticket=p_ticket;
 if m is null then return false;end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:sms:'||d,0));
 update hag_private.sms_confirmation_outbox set state=case when p_outcome='provider-blocked' then 'held' else p_outcome end,provider_sid=p_sid,finished_at=clock_timestamp() where ticket=p_ticket and state='reserved' and (p_outcome in ('held','cancelled') or started_at is not null);
 if not found then return false;end if;
 if p_outcome='provider-blocked' then
  insert into hag_private.sms_provider_blocks(destination) values(d) on conflict(destination) do update set blocked_at=clock_timestamp(),provider_unblocked_at=null;
  insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel)
  select id,'withdrawn','hag-sports-v1','Provider reported blocked SMS destination.','provider_stop','sms' from hag_private.hag_subscriptions where contact_method_id=m and status in ('pending','active');
  update hag_private.hag_subscriptions set status='withdrawn' where contact_method_id=m and status in ('pending','active');
  insert into hag_private.hag_suppressions(contact_method_id,reason,active) values(m,'stop',true) on conflict(contact_method_id,reason) do update set active=true;
 end if;
 return true;
end$$;
revoke all on function hag_private.sms_ack_claim(),hag_private.sms_ack_start(uuid),hag_private.sms_ack_finish(uuid,text,text) from public,anon,authenticated,service_role,hag_subscription_runtime,hag_gmail_dispatch,hag_gmail_control;
commit;
