-- DRAFT ONLY; apply to disposable database after earlier drafts.
-- A future runtime login would be provisioned separately with only membership in this role.
create role hag_subscription_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant usage on schema hag_private to hag_subscription_runtime;
grant execute on function hag_private.subscription_gateway_budget(text,text),
 hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text),
 hag_private.subscription_confirm_scope(text),hag_private.subscription_redeem(text,text),
 hag_private.subscription_edit(text,text[],text[],boolean,boolean,text)
 to hag_subscription_runtime;
revoke execute on function hag_private.subscription_gateway_budget(text,text),
 hag_private.subscription_gateway_issue(uuid,text,text,boolean,text,text,text[],boolean,text,text),
 hag_private.subscription_confirm_scope(text),hag_private.subscription_redeem(text,text),
 hag_private.subscription_edit(text,text[],text[],boolean,boolean,text) from service_role;
-- No public wrapper, LOGIN, password or production secret. Do not install on live database.
