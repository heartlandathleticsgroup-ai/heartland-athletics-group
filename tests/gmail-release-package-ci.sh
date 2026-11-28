#!/usr/bin/env bash
set -euo pipefail
# Only official pinned Deno binary + locked npm dependency may be fetched.
# All execution below is isolated: no Supabase or Google network access.
pkg="$(bash release/gmail/package.sh)"
scratch="$(mktemp -d /tmp/hag-deno-XXXXXX)"
trap 'rm -rf "$pkg" "$scratch"' EXIT
test -f "$pkg/public/preferences/consent.mjs"
grep -q 'GMAIL_RELEASE_ENABLED=false' "$pkg/public/admin/gmail-controls.mjs"
grep -q 'PREFERENCE_RELEASE_ENABLED=false' "$pkg/public/preferences/preferences.mjs"
curl --fail --silent --show-error --location --proto '=https' --max-time 90 \
 https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip -o "$scratch/deno.zip"
echo "e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609  $scratch/deno.zip" | sha256sum -c -
unzip -q "$scratch/deno.zip" -d "$scratch"
export DENO_DIR="$scratch/cache"
deno="$scratch/deno"
"$deno" --version
for fn in hag-gmail-control hag-gmail-worker hag-subscriptions; do
 dir="$pkg/supabase/functions/$fn"
 (cd "$dir"; "$deno" cache --frozen --config deno.json index.ts; "$deno" check --frozen --config deno.json index.ts)
done
# No --allow-net, --allow-run or project secrets in these tests.
"$deno" run --no-lock --no-prompt tests/gmail-release-runtime.test.mjs
dir="$pkg/supabase/functions/hag-gmail-control"
cat > "$dir/disabled-check.mjs" <<'JS'
import {handler,canonicalEdgeRequest} from "./edge-entry.mjs";
if(canonicalEdgeRequest(new Request("http://edge-internal/hag-gmail-control/oauth/gmail/callback?state=test"),"control").url!=="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-control/oauth/gmail/callback?state=test")throw Error("Internal route mapping");
let rejected=false;try{canonicalEdgeRequest(new Request("http://edge-internal/other"),"control");}catch{rejected=true;}if(!rejected)throw Error("Unrelated route accepted");
for(const kind of ["control","worker","preferences"]){
 const name={control:"hag-gmail-control",worker:"hag-gmail-worker",preferences:"hag-subscriptions"}[kind];
 const r=await handler(kind)(new Request("http://edge-internal/"+name));
 if(r.status!==503||!(await r.json()).disabled)throw Error("Release is not locked");
}
console.log("PASS: packaged Deno entrypoints start in disabled mode with no network permissions");
JS
(cd "$dir"; env HAG_GMAIL_RUNTIME_STATE=disabled "$deno" run --cached-only --frozen --allow-env=HAG_GMAIL_RUNTIME_STATE disabled-check.mjs)
bash tests/gmail-release-tls-ci.sh "$deno"
echo "PASS: locked dependency and review-only deployment package"
