-- Run AFTER both draft SQL files, in the SAME transaction; always ROLLBACK.
-- Synthetic data only. Never run with a committed fixture or output token values.
do $qa$
declare d text:='qa-'||gen_random_uuid()||'@example.invalid'; phone text:='+12025550123'; a text; b text; m text; e text; u text; j jsonb; mid uuid; sid uuid; n int;
begin
 if has_table_privilege('service_role','hag_private.subscription_capabilities','select') or has_function_privilege('anon','hag_private.subscription_redeem(text,text)','execute') or has_function_privilege('authenticated','hag_private.subscription_request(text,boolean,text,text,text[],boolean,text)','execute') or has_function_privilege('service_role','hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text)','execute') then raise exception 'grants wrong'; end if;
 execute 'set local role service_role';
 a:=hag_private.subscription_request('QA',true,'email',d,array['hag-announcements'],true,'draft-3c3-v1');
 b:=hag_private.subscription_request('QA',true,'email',d,array['camps-clinics'],true,'draft-3c3-v1');
 if a is null or b is null or a=b or length(a)<>64 then raise exception 'token issue';end if;
 if hag_private.subscription_redeem(a,'manage') is not null then raise exception 'wrong purpose accepted';end if;
 if hag_private.subscription_redeem(a,'confirm') is null then raise exception 'confirm failed';end if;
 if hag_private.subscription_redeem(a,'confirm') is not null then raise exception 'replay accepted';end if;
 execute 'reset role';
 select id into strict mid from hag_private.hag_contact_methods where destination=d;
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='hag-announcements' and status='active' and confirmation_event_id is not null) or not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='camps-clinics' and status='pending') then raise exception 'snapshot not isolated';end if;
 if not exists(select 1 from hag_private.subscription_capabilities where token_hash=extensions.digest(a,'sha256') and used_at is not null) then raise exception 'hash not recorded';end if;
 update hag_private.subscription_capabilities set expires_at=clock_timestamp()-interval '1 second' where token_hash=extensions.digest(b,'sha256');
 execute 'set local role service_role';
 if hag_private.subscription_redeem(b,'confirm') is not null then raise exception 'expired accepted';end if;
 m:=hag_private.subscription_access_request('email',d,'manage');
 if m is null then raise exception 'manage issue';end if;
 if hag_private.subscription_access_request('email',d,'manage') is not null then raise exception 'per-destination limit failed';end if;
 j:=hag_private.subscription_redeem(m,'manage');
 if j->>'channel' is distinct from 'email' or jsonb_array_length(j->'preferences')<>2 then raise exception 'preference read wrong';end if;
 e:=j->>'edit_token';
 if hag_private.subscription_edit(e,array['volunteer-updates'],array[]::text[],false,true,'draft-3c3-v1') then raise exception 'adult bypass';end if;
 if hag_private.subscription_edit(e,array['volunteer-updates'],array[]::text[],true,false,'draft-3c3-v1') then raise exception 'consent bypass';end if;
 if not hag_private.subscription_edit(e,array['volunteer-updates'],array['hag-announcements'],true,true,'draft-3c3-v1') then raise exception 'edit failed';end if;
 if hag_private.subscription_edit(e,array['hag-announcements'],array[]::text[],true,true,'draft-3c3-v1') then raise exception 'edit replay';end if;
 a:=hag_private.subscription_request('QA',true,'sms',phone,array['gus-macker-local'],true,'draft-3c3-v1');
 if a is null or hag_private.subscription_redeem(a,'confirm') is null then raise exception 'sms confirmation failed';end if;
 execute 'reset role';
 if not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='volunteer-updates' and status='active') or not exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and topic_code='hag-announcements' and status='withdrawn') then raise exception 'edit state wrong';end if;
 delete from hag_private.subscription_abuse;
 execute 'set local role service_role';
 u:=hag_private.subscription_access_request('email',d,'unsubscribe');
 m:=hag_private.subscription_access_request('email',d,'manage');
 if u is null or m is null then raise exception 'issue failed';end if;
 execute 'reset role';
 -- Seed the exact global minute bucket to simulate exhausted ordinary redemption.
 insert into hag_private.subscription_abuse(scope,bucket,window_start,hits) values('redeem-global','all',date_trunc('minute',clock_timestamp()),120) on conflict(scope,bucket,window_start) do update set hits=120;
 execute 'set local role service_role';
 if hag_private.subscription_redeem(m,'manage') is not null then raise exception 'redeem rate limit failed';end if;
 if hag_private.subscription_redeem(u,'unsubscribe') is null then raise exception 'unsubscribe improperly rate-limited';end if;
 if hag_private.subscription_redeem(u,'unsubscribe') is not null then raise exception 'unsubscribe replay';end if;
 execute 'reset role';
 delete from hag_private.subscription_abuse where scope='redeem-global';
 execute 'set local role service_role';
 if hag_private.subscription_redeem(m,'manage') is not null then raise exception 'old capability remained';end if;
 if hag_private.subscription_request('QA',true,'email',d,array['tournaments-events'],true,'draft-3c3-v1') is not null then raise exception 'suppression bypass';end if;
 execute 'reset role';
 if not exists(select 1 from hag_private.hag_suppressions where contact_method_id=mid and reason='unsubscribe' and active) or exists(select 1 from hag_private.hag_subscriptions where contact_method_id=mid and status<>'withdrawn') then raise exception 'unsubscribe state wrong';end if;
 if not exists(select 1 from hag_private.hag_subscriptions s join hag_private.hag_contact_methods cm on cm.id=s.contact_method_id where cm.destination=phone and s.status='active') then raise exception 'cross channel unsubscribe';end if;
 if not exists(select 1 from hag_private.hag_consent_events where channel='sms' and source='sms_confirmation') then raise exception 'sms proof missing';end if;
 -- A fresh verification can inspect suppressed preferences but cannot clear suppression or reactivate them.
 delete from hag_private.subscription_abuse;
 execute 'set local role service_role';
 m:=hag_private.subscription_access_request('email',d,'manage');
 j:=hag_private.subscription_redeem(m,'manage');
 if j->>'suppressed' is distinct from 'true' then raise exception 'suppression not displayed';end if;
 if hag_private.subscription_edit(j->>'edit_token',array['hag-announcements'],array[]::text[],true,true,'draft-3c3-v1') then raise exception 'suppression edit bypass';end if;
 execute 'reset role';
 -- Simulate global issuance ceiling before a new destination is allocated.
 insert into hag_private.subscription_abuse(scope,bucket,window_start,hits) values('issue-global','all',date_trunc('minute',clock_timestamp()),30) on conflict(scope,bucket,window_start) do update set hits=30;
 execute 'set local role service_role';
 if hag_private.subscription_request('QA',true,'email','global-limit@example.invalid',array['hag-announcements'],true,'draft-3c3-v1') is not null then raise exception 'global issue limit bypass';end if;
 execute 'reset role';
 if exists(select 1 from hag_private.hag_contact_methods where destination='global-limit@example.invalid') then raise exception 'rate limited record created';end if;
end $qa$;
select 'PASS: grants, hashed tokens, scope, replay, expiry, snapshot, verified edits, consent, abuse ceilings, unsubscribe, suppression and channel isolation' as result;
