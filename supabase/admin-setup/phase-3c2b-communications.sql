-- Read-only, bounded administrator projections. Existing forced RLS applies to the caller.
create function public.hag_communications_read(p_view text,p_offset integer default 0,p_channel text default null)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $fn$
declare result jsonb;
begin
 if auth.uid() is null or hag_private.admin_session_state() is distinct from 'authorized' then raise exception 'Access denied' using errcode='42501'; end if;
 if p_offset is null or p_offset<0 or p_offset>100000 or p_offset%50<>0 or (p_channel is not null and (p_channel not in ('email','sms') or p_view is distinct from 'subscribers')) then raise exception 'Invalid page or channel' using errcode='22023'; end if;
 case p_view
 when 'contacts' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select c.id,c.display_name,c.adult_confirmed,c.created_at,m.channel,m.destination,m.verified_at from hag_private.hag_contacts c left join hag_private.hag_contact_methods m on m.contact_id=c.id order by c.created_at desc,c.id,m.id limit 51 offset p_offset) q;
 when 'inquiries' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select i.id,i.contact_name,i.contact_email,i.contact_phone,t.label as topic,i.message,i.status,i.source,i.created_at from hag_private.hag_inquiries i join hag_private.hag_topics t on t.code=i.topic_code and t.purpose=i.topic_purpose order by i.created_at desc,i.id limit 51 offset p_offset) q;
 when 'subscribers' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select s.id,c.display_name,m.destination,s.channel,t.label as topic,s.status,(s.confirmation_event_id is not null) as has_confirmation,exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=m.id and x.active) as suppressed,s.created_at from hag_private.hag_subscriptions s join hag_private.hag_contact_methods m on m.id=s.contact_method_id join hag_private.hag_contacts c on c.id=m.contact_id join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose where (p_channel is null or s.channel=p_channel) order by s.created_at desc,s.id limit 51 offset p_offset) q;
 when 'preferences' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select t.code,t.label,t.active,(select count(*) from hag_private.hag_subscriptions s where s.topic_code=t.code and s.topic_purpose=t.purpose and s.channel='email' and s.status='active' and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=s.contact_method_id and x.active)) as email_active,(select count(*) from hag_private.hag_subscriptions s where s.topic_code=t.code and s.topic_purpose=t.purpose and s.channel='sms' and s.status='active' and not exists(select 1 from hag_private.hag_suppressions x where x.contact_method_id=s.contact_method_id and x.active)) as sms_active from hag_private.hag_topics t where t.purpose='subscription' order by t.label,t.code limit 51 offset p_offset) q;
 when 'consent' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select e.id,c.display_name,m.destination,e.channel,t.label as topic,e.event_kind,e.consent_version,e.consent_text,e.source,e.occurred_at from hag_private.hag_consent_events e join hag_private.hag_subscriptions s on s.id=e.subscription_id join hag_private.hag_contact_methods m on m.id=s.contact_method_id join hag_private.hag_contacts c on c.id=m.contact_id join hag_private.hag_topics t on t.code=s.topic_code and t.purpose=s.topic_purpose order by e.occurred_at desc,e.id limit 51 offset p_offset) q;
 when 'suppressions' then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (select x.id,c.display_name,m.destination,m.channel,x.reason,x.active,x.created_at from hag_private.hag_suppressions x join hag_private.hag_contact_methods m on m.id=x.contact_method_id join hag_private.hag_contacts c on c.id=m.contact_id order by x.created_at desc,x.id limit 51 offset p_offset) q;
 else raise exception 'Unknown view' using errcode='22023';
 end case;
 return jsonb_build_object('version',1,'rows',result);
end
$fn$;
revoke all on function public.hag_communications_read(text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.hag_communications_read(text,integer,text) to authenticated;
