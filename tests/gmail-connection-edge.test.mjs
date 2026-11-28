import assert from "node:assert/strict";
const env={HAG_GMAIL_RUNTIME_STATE:"disabled",HAG_GMAIL_OAUTH_ENABLED:"false",HAG_GMAIL_SEND_ENABLED:"false",HAG_PREFERENCES_ENABLED:"false",HAG_SPORT_PREFERENCES_ENABLED:"false",HAG_GMAIL_CONTROL_DATABASE_URL:"postgresql://hag_gmail_control_login.unrqbfngcgvqnytxbtgj:fictional-password@aws-0-us-east-2.pooler.supabase.com:6543/postgres",HAG_DATABASE_CA_PEM:"-----BEGIN CERTIFICATE-----\nfictional\n-----END CERTIFICATE-----",HAG_GMAIL_CLIENT_ID:"fixture.apps.googleusercontent.com",HAG_GMAIL_CLIENT_SECRET:"fixture-client-secret",HAG_PRIVATE_POSTAL_FOOTER:"Fictional postal footer for isolated acceptance",HAG_PROJECT_PUBLISHABLE_KEY:"sb_publishable_fixture",HAG_GMAIL_VAULT_KEY:"0123456789abcdef".repeat(4),HAG_GMAIL_VAULT_KEY_VERSION:"one"};
for(const [k,v] of Object.entries(env))Deno.env.set(k,v);
const path="../release/gmail/connection-edge-entry.mjs";
const request=(s,method="GET")=>new Request("http://edge-internal/hag-gmail-control"+s,{method});
const {handler}=await import(path+"?disabled");
assert.equal((await handler(request("/readiness"))).status,204);
assert.equal((await handler(request("/oauth/gmail/prepare","POST"))).status,503);
for(const n of ["HAG_GMAIL_SEND_ENABLED","HAG_PREFERENCES_ENABLED","HAG_SPORT_PREFERENCES_ENABLED"]){
 Deno.env.set(n,"true");const m=await import(path+"?"+n);assert.equal((await m.handler(request("/readiness"))).status,503);Deno.env.set(n,"false");
}
Deno.env.set("HAG_DATABASE_CA_PEM","malformed");const bad=await import(path+"?malformed");assert.equal((await bad.handler(request("/readiness"))).status,503);
console.log("PASS: hosted entry config shape, disabled route, fail-closed flags and invalid CA, no network permissions");
