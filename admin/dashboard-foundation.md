# Phase 3C.2A — Administration dashboard foundation
Status: foundation merged in PR #25; live device acceptance pending. App-ready refinement approved 2026-11-27.
Scope: eight-module responsive, read-only presentation inside the existing authenticated panel at /admin/. No new database schema, private records, publishing actions, forms, external integrations, or paid services.
Existing backend access checks, approved passkey path, password + TOTP fallback, credential registration restrictions, session rechecks and lock/sign-out behavior remain unchanged. Static HTML/JS can be downloaded by anyone; it contains only nonsensitive module names and planned descriptions. Hiding the panel is a UI convenience, not a data authorization boundary. Future records must be fetched only through separately reviewed server-enforced permissions, with fresh step-up for high-risk actions. Never place private sponsor, financial, child or family data in static assets.
Acceptance: branch tests and manual iPhone + desktop navigation; unauthenticated view, password + TOTP, passkey, session sign-out and expiry, responsive layout, no changes to public website or Formspree. No dashboard data actions are enabled. Rollback: revert this PR; existing auth and database are unaffected. Separate deployment review before merge. 

## App-ready architecture — approved direction
Website first; the Mobile App module is informational and explicitly Inactive — Future Integration. Do not connect the existing app backend, migrate app data, change app source, activate notifications, provision services, or purchase anything. No operational app development until a separate owner approval.

Future modules should design reusable domain records with stable IDs, timestamps, versioned contracts, lifecycle states (draft/review/published/archived), and explicit channel eligibility. Channel eligibility is not publication: website publishing needs separate authorization and audit; mobile channel publishing remains disabled by default, enforced server-side when implemented. Use a canonical content model with platform-specific presentation adapters rather than duplicating editorial data. Do not assume the existing website and app databases can be merged; review schema, ownership, privacy, access policies, and migration needs before any future integration. No new schema or API is implemented in this refinement.

Separate internal administration records from intentionally public projections. Financial, contact, youth/player and family information is private by default; sharing must be separately authorized and consent-aware. Only approved public fields may flow to a future app. Keep administrative auth separate from public consumer identity, enforce access in backend policies, require fresh step-up for sensitive operations, and maintain audit history. Plan backward-compatible contracts and opt-in integrations; do not introduce speculative dependencies.

## Website-first roadmap
- 3C.2A: dashboard foundation and app-ready status; device acceptance.
- 3C.2B: content management, reusable drafts/review/publishing contracts; start read-only or draft-only, no live publishing before review.
- 3C.2C: events and Gus Macker, reusable public event projections.
- 3C.2D: sponsor management, separate private commitments from approved public recognition.
- 3C.2E: Enforcers, private roster/guardian information separated from approved public content.
- 3C.2F: inquiries, retain Formspree delivery; review secure intake and privacy before integration.
- 3C.2G: mobile integration — deferred indefinitely, separate owner approval, no schedule.
Each active phase gets separate implementation, security review and acceptance. The app module is a status/roadmap panel only.
