-- Operational rollback, preserves all consent and suppressions. Not a schema downgrade.
-- Run only after explicit approval; stop worker scheduling and restore old site first.
begin;
set local lock_timeout='3s';
do $rollback$ begin perform hag_private.gmail_disable(true); end $rollback$;
-- Credential is encrypted and return value must not be logged. Provider grant
-- must be separately revoked by the owner in Google account security.
revoke hag_gmail_control from hag_gmail_control_login;
revoke hag_gmail_dispatch from hag_gmail_dispatch_login;
revoke hag_subscription_runtime from hag_subscription_gateway_login;
alter role hag_gmail_control_login nologin;
alter role hag_gmail_dispatch_login nologin;
alter role hag_subscription_gateway_login nologin;
commit;
