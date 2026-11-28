#!/usr/bin/env bash
# Assemble a review-only local package. Never runs Supabase CLI or writes to production.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d /tmp/hag-release-package-XXXXXX)"
for spec in hag-gmail-control:control hag-gmail-worker:worker hag-subscriptions:preferences; do
 name="${spec%%:*}"; kind="${spec##*:}"
 dir="$out/supabase/functions/$name"
 mkdir -p "$dir/runtime"
 cp "$root/release/gmail/runtime/"*.mjs "$dir/runtime/"
 cp "$root/release/gmail/edge-entry.mjs" "$dir/edge-entry.mjs"
 cp "$root/release/gmail/deno.json" "$root/release/gmail/deno.lock" "$dir/"
 printf 'import {handler} from "./edge-entry.mjs";\nDeno.serve(handler("%s"));\n' "$kind" > "$dir/index.ts"
done
# Explicitly disable platform JWT gateway checks: individual routes have their
# own user-context JWT proof, state/cookie proof, worker secret or public token.
cat > "$out/supabase/config.toml" <<'TOML'
project_id = "hag-gmail-release-local"
[functions.hag-gmail-control]
verify_jwt = false
[functions.hag-gmail-worker]
verify_jwt = false
[functions.hag-subscriptions]
verify_jwt = false
TOML
cp "$root/release/gmail/consolidated-migration.sql" "$root/release/gmail/welcome-incremental.sql" "$root/release/gmail/sport-preferences-incremental.sql" "$root/release/gmail/operational-rollback.sql" "$out/"
mkdir -p "$out/public/preferences" "$out/public/admin" "$out/public/subscribe"
cp "$root/release/gmail/public/preferences/"* "$out/public/preferences/"
cp "$root/release/gmail/runtime/consent.mjs" "$out/public/preferences/consent.mjs"
cp "$root/subscribe/"*.mjs "$root/subscribe/index.html" "$out/public/subscribe/"
cp "$root/admin/sport-admin.mjs" "$out/public/admin/"
cp "$root/admin/index.html" "$root/admin/auth.js" "$root/admin/gmail-controls.mjs" "$out/public/admin/"
# This is an overlay, not a replacement for existing site files. Keep both release locks false.
printf '%s\n' "$out"
