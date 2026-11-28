# E.9 Gmail release candidate — review and acceptance

This is a draft-only package. It must not be merged, deployed, or enabled merely because a local test passes. No credentials are included. `bash release/gmail/package.sh` assembles a temporary review package; it does not deploy anything.

## First deployment boundary (separate explicit owner approval)
Review the final exact-commit CI, compare the live schema and grants to the migration preflight, check free-tier headroom, and obtain an appropriate backup/rollback plan. Apply only the reviewed consolidated migration, leaving runtime login roles NOLOGIN and Gmail disconnected. Deploy only the three new disabled Edge entrypoints, not the existing passkey function or public/admin site overlay. Keep HAG_GMAIL_RUNTIME_STATE unset or disabled and HAG_GMAIL_OAUTH_ENABLED, HAG_GMAIL_SEND_ENABLED and HAG_PREFERENCES_ENABLED false. Keep both UI release flags false. Do not supply Google credentials, schedule workers, register the callback or change DNS. Verify disabled responses, route boundaries, absence of unintended grants, and existing auth, public site, Formspree and info@ routing. Stop if any check fails.

## Later activation requirements (not part of disabled deployment)
- Confirm hosted gateway cookie handling, redirect behavior, callback query/header log redaction, deployed Deno compatibility, Supavisor project/login mapping and TLS CA/hostname verification. The isolated TLS server is not the hosted database.
- Verify the exact Google callback candidate with Google before registration: https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-control/oauth/gmail/callback . Login hint is not proof of mailbox identity. Obtain owner approval for actual alias verification and narrowly scoped Gmail authorization.
- Provision separate narrow login passwords and connection URLs in private secret storage only: HAG_GMAIL_CONTROL_DATABASE_URL, HAG_GMAIL_DISPATCH_DATABASE_URL, HAG_SUBSCRIPTION_DATABASE_URL, HAG_DATABASE_CA_PEM. Do not use broad service-role or database-owner credentials. Review the exact environment contract in edge-entry.mjs before enabling anything.
- Store HAG_GMAIL_CLIENT_ID, HAG_GMAIL_CLIENT_SECRET, HAG_PRIVATE_POSTAL_FOOTER, HAG_PROJECT_PUBLISHABLE_KEY, HAG_GMAIL_WORKER_KEY, HAG_GMAIL_VAULT_KEY and its version, HAG_EMAIL_OUTBOX_KEY and its version, and optional rotation keys only in approved private configuration. Never post confidential values in chat, source control, logs or public pages.
- Do not schedule a worker using a reusable secret in plaintext pg_net queued headers. A secure scheduler or short-lived authenticated dispatch mechanism needs separate review. No scheduler is installed by this package.
- Review trusted ingress source handling and availability under the conservative shared rate bucket. Verify release preference page and admin controls on actual supported devices, including keyboard and Safari. SMS collection remains unavailable until a real confirmed-opt-in SMS provider is separately approved. Verify signup activates eligible email selections without confirmation, queues one welcome acknowledgment only when Gmail is separately enabled, and never queues another welcome on duplicate or additional topic signup. Confirm preference/unsubscribe links and suppression checks before launch.
- Approve actual Gmail authorization, worker activation, consent-policy publication and public launch separately; the package is not approval to send.

## Rollback
Stop worker/public traffic first, preserve consent history and suppressions, use operational-rollback.sql to disable/disconnect and revoke runtime memberships/LOGIN, and restore prior site assets if a later overlay has been released. If Google was ever connected, separately revoke its grant. Do not destructively delete subscriber records. The rollback script is an operational shutoff, not a schema-uninstall script.

## Security review
Read-only inspection found existing leaked-password protection disabled; no authentication setting or paid-plan change is included. Review that separately without weakening existing MFA/passkey access. The existing private passkey tables intentionally deny general access. See https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection .

All production tests requiring credentials or live sends remain prohibited in E.9. Local CI uses ephemeral databases, reserved example addresses, simulated Google responses and offline Deno package checks. No messages are sent.

## Public subscriber release additions (draft)
Signup and preference access remain locked in the public source. SMS is intentionally unavailable until a verified provider is approved. The incremental candidate now gates signup on sender enablement; opt-in, one-time welcome marker, both capability links and encrypted outbox admission share one transaction. Existing dispatch fence validates both links and suppressions before sending. No live delivery, scheduled worker, DNS, paid service or hosted schema change is authorized by this commit. Review the private postal footer, Gmail alias identity, operational settings, retention, contact monitoring and actual website data collection before making the policies effective.

Hosted baseline inspection confirmed the original E.9 migration and three disabled functions are already installed. Do not reapply consolidated-migration.sql on that database. Apply only welcome-incremental.sql after exact-commit tests and hosted preflight pass; the migration refuses nonempty or enabled baselines. Then replace only the three disabled release entrypoints using the reviewed package and leave all delivery/UI locks disabled. For a clean isolated test database apply both migrations in order. Do not change auth, CMS or Formspree.


### Sport-aware subscription candidate (review only)
After the baseline and welcome incremental, the sport-preferences incremental adds private sport storage, secure editing, CMS audience and draft controls. It revokes old direct signup/edit runtime grants. Run the baseline tests before the sport incremental in disposable CI; do not install on the hosted project yet. All public and CMS release flags stay false. SMS confirmation has no runtime grants, and targeted drafts have no live delivery adapter. Do not flip any flags without provider verification and exact-release acceptance.


### Production readiness
See `previews/subscriptions/production-readiness.md`. The sport incremental now adds a generation-bound sender review requirement; it remains review-only and must not be installed before coordinated release acceptance. The public DNS/GET probe does not authenticate or send messages. Campaign delivery remains unimplemented and locked.


### Private credential preparation
See `PRIVATE-CONFIGURATION.md` and `disabled-deployment-preflight.sql`. This revision adds an explicit source-level runtime lock overriding environment flags; the disabled package cannot activate even if old secrets exist. No live changes are made by the package script. Existing hosted E.9 must not be reapplied. No new backup work or purchases.


### Private runtime provisioning
The owner-local `private-runtime-setup.py` utility is staged, with no hosted execution from CI. It performs an explicit project-targeted, first-time secret setup and temporary narrow TLS role tests, restoring NOLOGIN. See PRIVATE-CONFIGURATION.md. Do not use on an already-provisioned project. The deployed hard lock remains unchanged.

## Production reconciliation — November 27, 2026
The live connection-only implementation (PRs #33, #35, #36) is authoritative. Do not deploy the older aggregate edge-entry to hag-gmail-control, replace the live Gmail module with gmail-controls.mjs, reapply the historical schema, or reset credentials. The aggregate package is isolated review material only. OAuth successfully stored an encrypted send-only grant at generation 1 after correcting the Google client secret. All delivery and gateway roles remain NOLOGIN; no live messages or public signup approved. Preserve strict-origin browser form handoff and no-referrer API requests. Future dispatch and preferences must be independently gated and deployed without replacing control. The previous draft-only administration Gmail module remains a fixture for existing isolated tests, not a live attachment.
