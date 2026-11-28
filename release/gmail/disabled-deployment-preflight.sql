-- Read-only production preflight. No secrets, role changes, or data returned.
begin read only;
do $preflight$
begin
 if to_regclass('hag_private.gmail_connection') is null
 or to_regprocedure('hag_private.subscription_email_opt_in(uuid,text,boolean,text,text[],boolean,text)') is null then raise exception 'E.9 baseline missing';end if;
 if to_regprocedure('hag_private.subscription_email_opt_in_welcome(uuid,text,boolean,text,text[],boolean,text,text,text)') is not null
 or to_regclass('hag_private.sport_preferences') is not null then raise exception 'Incremental already installed; do not reapply';end if;
 if (select count(*) from hag_private.gmail_connection where singleton and not enabled and credential is null)<>1
 or exists(select 1 from hag_private.hag_subscriptions)
 or exists(select 1 from hag_private.hag_contact_methods)
 or exists(select 1 from hag_private.subscription_email_outbox)
 or exists(select 1 from hag_private.subscription_capabilities)
 or exists(select 1 from hag_private.hag_suppressions) then raise exception 'Expected empty disabled baseline';end if;
 if (select count(*) from pg_roles where rolname in ('hag_gmail_control_login','hag_gmail_dispatch_login','hag_subscription_gateway_login') and not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolinherit)<>3 then raise exception 'Runtime roles not safely disabled';end if;
 if has_function_privilege('authenticated','hag_private.gmail_enable_reviewed(bigint)','execute')
 or has_function_privilege('hag_gmail_control','hag_private.gmail_enable_reviewed(bigint)','execute')
 or has_function_privilege('hag_gmail_dispatch','hag_private.gmail_enable_reviewed(bigint)','execute') then raise exception 'Unsafe sender enablement grant';end if;
end $preflight$;
select 'PASS: empty E.9 baseline, no runtime logins, no activation grants to browser or control roles' as result;
rollback;
