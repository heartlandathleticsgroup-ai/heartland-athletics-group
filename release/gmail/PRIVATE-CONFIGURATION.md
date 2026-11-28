# Private configuration and disabled deployment preparation

Status: owner confirmed existing no-reply Send mail as alias and exact authorized redirect URI saved. No actual Google authorization, secret ingestion, production migration, deployment, scheduling or sends have occurred in this batch. Do not share values in issues, source, chat, screenshots, logs or shell history.

## First private entry (existing Google OAuth client; no new client or billing)
Use the project’s Edge Function Secrets dashboard: https://supabase.com/dashboard/project/unrqbfngcgvqnytxbtgj/functions/secrets . Inspect names only. Do not rotate or overwrite existing credentials without checking the intended client. From Google Auth Platform Clients, copy the existing web client ID and client secret directly into the two matching Supabase secret fields, not into chat. If the existing secret is no longer retrievable, stop and review secure rotation instead of creating another client. No credentials are required for the hard-locked disabled deployment itself.

| Name | Value/source |
|---|---|
| HAG_GMAIL_RUNTIME_STATE | disabled |
| HAG_GMAIL_OAUTH_ENABLED | false |
| HAG_GMAIL_SEND_ENABLED | false |
| HAG_PREFERENCES_ENABLED | false |
| HAG_SPORT_PREFERENCES_ENABLED | false |
| HAG_GMAIL_CLIENT_ID | Existing web client ID, direct private entry |
| HAG_GMAIL_CLIENT_SECRET | Existing web client secret, direct private entry |

Source RELEASE_RUNTIME_UNLOCKED=false takes precedence even over enabled env flags. This package cannot open a connection or call Google. All website flags remain false. No separate SMS credentials or service.

## Later private provisioning (do not enable logins in this batch)
- HAG_GMAIL_CONTROL_DATABASE_URL, HAG_GMAIL_DISPATCH_DATABASE_URL, HAG_SUBSCRIPTION_DATABASE_URL: three independently generated passwords, narrow existing login identities only, project-qualified transaction pooler user, port 6543, verified project region/host. No owner/service role credential. Passwords enter via secure local prompt and private storage, never command arguments or printed SQL.
- HAG_DATABASE_CA_PEM: verify actual pooler certificate chain and hostname; do not disable TLS validation.
- HAG_GMAIL_VAULT_KEY, HAG_EMAIL_OUTBOX_KEY, HAG_GMAIL_WORKER_KEY: three distinct cryptographically random 32-byte hex values generated locally and entered directly into approved secrets storage; no printed keys in chat. HAG_GMAIL_VAULT_KEY_VERSION and HAG_EMAIL_OUTBOX_KEY_VERSION are nonsecret version labels. Never replace existing encryption keys blindly.
- HAG_PRIVATE_POSTAL_FOOTER: privately approved valid business postal address; never expose on website or repo.
- HAG_PROJECT_PUBLISHABLE_KEY: the existing project publishable key only.
- Optional rotation keys are not required for first activation. Keep unset until a reviewed rotation procedure.
- The connector cannot read or write Edge Function secrets; do not infer that any names are already configured. Owner should verify names only after saving.

## Coordinated disabled deployment sequence
1. Confirm exact-head CI and inspect disabled endpoints, project identity, baseline and role grants. Run disabled-deployment-preflight.sql read-only; do not reapply consolidated-migration.sql. Existing passkey function and public site are excluded.
2. Use existing rollback plan, no new backup work. Apply welcome-incremental.sql then sport-preferences-incremental.sql only after deployment authorization and compatibility review. Preserve all existing CMS/auth data. Stop on any mismatch. Keep runtime logins NOLOGIN.
3. Deploy only three reviewed disabled functions, using package.sh output: hag-gmail-control, hag-gmail-worker, hag-subscriptions. Never overwrite hag-admin-passkey or publish the public/admin overlay in this stage. Platform JWT configuration remains as existing; source hard lock returns 503 for all valid messaging routes regardless of flags.
4. Verify deployed versions, 503 disabled responses, zero subscriptions/outbox/capabilities, unchanged role attributes, RLS and grants; inspect security advisors. Recheck admin login, CMS, Formspree and public website without submitting a live inquiry.
5. Only a later reviewed code and configuration change may unlock connection-only OAuth. Narrow admin form-action to exact handoff endpoint, verify cookie/redirect and callback, do not enable sending. Worker and public collection remain off. After actual sender verification, controlled acceptance and legal/operational review, separately approve live sending. Campaign delivery adapter and scheduler not implemented; SMS disabled.


## Owner-local first-time runtime configuration (approved preparation batch)
The two additive increments are now installed and the three hosted messaging functions are hard-locked v7. Do not reapply either increment. The new `private-runtime-setup.py` utility is for an interactive owner Terminal, not CI or chat. It requires Python 3, psql and an already authenticated Supabase CLI. Run the offline `--self-test` first. Use the H.A.G. project's Connect panel shared pooler host and official database CA certificate; use the existing database password (do not reset), existing publishable key and approved private postal footer. The tool prompts privately, generates three independent database passwords plus three distinct encryption/worker keys, tests each narrow transaction-pooler identity with verify-full TLS, and returns each login to NOLOGIN immediately. It uses a five-minute password expiry as a crash safeguard. It stores only the 11 new runtime secrets via a temporary 0600 file and the official authenticated CLI, then removes the temporary file. The original seven secret names must already exist; it refuses to overwrite existing runtime secrets. No secret values are printed or transmitted to GitHub, ChatGPT or Google. The SCRAM verifier rather than plaintext password is sent to PostgreSQL. Do not run if the owner cannot establish the project/CA identity or the production locks have changed. After success report only the PASS/COMPLETE lines; never send credential screenshots. CLI compatibility and actual hosted TLS are owner-local acceptance gates; CI only exercises the offline self-test.

If interrupted or a shutoff cannot be confirmed, use Supabase SQL Editor on the correct project to run `ALTER ROLE hag_gmail_control_login NOLOGIN; ALTER ROLE hag_gmail_dispatch_login NOLOGIN; ALTER ROLE hag_subscription_gateway_login NOLOGIN;` and confirm all three are NOLOGIN. Do not rerun after partial secret upload; inspect names privately and reconcile first. No role changes, secrets, authorization or messaging calls have been performed by the assistant in this preparation batch.
