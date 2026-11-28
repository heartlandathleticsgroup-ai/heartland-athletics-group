-- DRAFT: no production installation or public HTTP route approved.
-- One destination per invocation, no cross-channel linking without verified control.
-- Caller must be a future reviewed server gateway with abuse controls.
create function hag_private.stage_subscription_request(p_name text,p_adult boolean,p_channel text,p_destination text,p_topics text[],p_consent boolean,p_version text)
returns void language plpgsql volatile security definer set search_path=''
as $fn$
declare method_id uuid; contact_id uuid; sub_id uuid; topic text; wording text; version constant text:='draft-3c3-v1';
begin
 if p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_adult is distinct from true or p_consent is distinct from true or p_version is distinct from version then raise exception 'Invalid request' using errcode='22023'; end if;
 if p_channel is null or p_channel not in ('email','sms') or p_destination is null then raise exception 'Invalid contact method' using errcode='22023'; end if;
 if (p_channel='email' and (char_length(p_destination)>254 or p_destination<>lower(btrim(p_destination)) or p_destination !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or p_destination ~ '[[:cntrl:]]')) or (p_channel='sms' and p_destination !~ '^[+][1-9][0-9]{7,14}$') then raise exception 'Invalid contact method' using errcode='22023'; end if;
 if p_topics is null or cardinality(p_topics) not between 1 and 9 or array_ndims(p_topics) is distinct from 1 or (select count(distinct x) from unnest(p_topics) x)<>cardinality(p_topics) or exists(select 1 from unnest(p_topics) x where x is null or not exists(select 1 from hag_private.hag_topics t where t.code=x and t.purpose='subscription' and t.active and t.code in ('hag-announcements','enforcers-updates','enforcers-tryouts','gus-macker-local','gus-macker-registration','camps-clinics','tournaments-events','sponsorship-updates','volunteer-updates'))) then raise exception 'Invalid topics' using errcode='22023'; end if;
 wording:=case p_channel when 'email' then 'I agree to receive marketing email from Heartland Athletics Group for the email topics I select. I can unsubscribe at any time. Consent is optional.' else 'I agree to receive recurring automated marketing text messages from Heartland Athletics Group at the number I provide, for the SMS topics I select. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.' end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hag-subscription:'||p_channel||':'||p_destination,0));
 select m.id into method_id from hag_private.hag_contact_methods m where m.channel=p_channel and m.destination=p_destination;
 if method_id is null then
  insert into hag_private.hag_contacts(display_name,adult_confirmed) values(btrim(p_name),true) returning id into contact_id;
  insert into hag_private.hag_contact_methods(contact_id,channel,destination) values(contact_id,p_channel,p_destination) returning id into method_id;
 end if;
 -- Existing identities are never edited. Active suppression blocks all new topic requests.
 if exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=method_id and x.active) then return; end if;
 foreach topic in array p_topics loop
  sub_id:=null;
  insert into hag_private.hag_subscriptions(contact_method_id,channel,topic_code,status) values(method_id,p_channel,topic,'pending') on conflict(contact_method_id,topic_code) do nothing returning id into sub_id;
  -- No changes to existing pending/active/withdrawn rows. Fresh re-consent requires verified flow.
  if sub_id is not null then
   insert into hag_private.hag_consent_events(subscription_id,event_kind,consent_version,consent_text,source,channel) values(sub_id,'requested',version,wording,'website',p_channel);
  end if;
 end loop;
end $fn$;
revoke all on function hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text) from public,anon,authenticated,service_role;
grant execute on function hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text) to service_role;
-- No public wrapper. No client grants, confirmation token, provider or message sending.
