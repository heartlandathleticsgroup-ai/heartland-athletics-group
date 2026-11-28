import assert from "node:assert/strict";
import {createSenderTestRoute,ORIGIN,TEST_ID} from "../release/gmail/runtime/sender-test-route.mjs";
import {createCredentialVault} from "../release/gmail/runtime/backend.mjs";
import {createGmailAdminClient} from "../admin/gmail-connection.mjs";
const now=1000000,actor="00000000-0000-4000-8000-000000000002",session="00000000-0000-4000-8000-000000000003",bearer="fixture.header.signature",url="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-sender-test/run";
const cfg={runtime:"approved-runtime",oauth:true,send:false,preferences:false,sportPreferences:false,clientId:"fixture.apps.googleusercontent.com",clientSecret:"fixture-client-secret",postalFooter:"Fixture postal footer for isolated acceptance",publishableKey:"sb_publishable_fixture",dispatchDb:"postgresql://hag_gmail_dispatch_login.unrqbfngcgvqnytxbtgj:fictional-password@aws-0-us-east-2.pooler.supabase.com:6543/postgres",ca:"-----BEGIN CERTIFICATE-----\nfictional\n-----END CERTIFICATE-----",vault:{key:"0123456789abcdef".repeat(4),version:"fixture"}};
const vault=createCredentialVault(cfg.vault);
let approved=false,claimed=false,started=false,finished=null,proofAllowed=true,drivers=0,providerCalls=0;
const postgres=o=>{drivers++;assert.equal(o.username.split(".")[0],"hag_gmail_dispatch_login");assert.equal(o.ssl.rejectUnauthorized,true);return {async begin(fn){return fn({unsafe:async(q,args=[])=>{
 if(q.includes("current_user"))return [{role:"hag_gmail_dispatch",login:"hag_gmail_dispatch_login",narrow:true}];
 if(!q.startsWith("select hag_private."))return [];
 assert.equal(args[0],TEST_ID);
 if(q.includes("gmail_sender_test_claim")){if(!approved||claimed)return [{value:null}];claimed=true;return [{value:{testId:TEST_ID,generation:1,recipient:"jhawkins@heartlandathleticsgroup.com",credential:vault.seal({token:"fixture-refresh-token"},"refresh"),keyVersion:"fixture"}}];}
 if(q.includes("gmail_sender_test_start")){assert.equal(args[1],1);if(!claimed||started)return [{value:false}];started=true;return [{value:true}];}
 if(q.includes("gmail_sender_test_finish")){finished=args[1];return [{value:true}];}
 throw Error("Unexpected DB call");
 }});},async end(){}};};
const json=x=>new Response(JSON.stringify(x),{headers:{"Content-Type":"application/json"}});
const fetcher=async(u,o)=>{if(u.endsWith("/rpc/hag_gmail_admin_proof"))return json(proofAllowed?{gate:"authorized",sessionActive:true,actor,session,stepUpAt:now}:null);
 providerCalls++;if(u==="https://oauth2.googleapis.com/token"){assert.ok(claimed&&!started);assert.equal(new URLSearchParams(o.body).get("grant_type"),"refresh_token");return json({access_token:"fixture-access-token",token_type:"Bearer",expires_in:3599});}
 assert.equal(u,"https://gmail.googleapis.com/gmail/v1/users/me/messages/send");assert.ok(started);return json({id:"fixture-message"});
};
for(const flag of ["send","preferences","sportPreferences"])assert.throws(()=>createSenderTestRoute({config:{...cfg,[flag]:true},postgres,fetcher}));
const rt=createSenderTestRoute({config:cfg,postgres,fetcher,now:()=>now});
assert.equal((await rt(new Request(url.replace("/run","/readiness")))).status,204);assert.equal(drivers,0);
const post=(u=url,headers={origin:ORIGIN,authorization:"Bearer "+bearer},body)=>rt(new Request(u,{method:"POST",headers,body}));
assert.equal((await post(url,{origin:"https://example.invalid",authorization:"Bearer "+bearer})).status,403);
assert.equal((await post(url,{origin:ORIGIN})).status,403);
assert.equal((await post(url,{origin:ORIGIN,authorization:"Bearer "+bearer},"{}")).status,403);
assert.equal((await post(url+"?test=1")).status,404);assert.equal(providerCalls,0);
proofAllowed=false;assert.equal((await post()).status,403);assert.equal(drivers,0);proofAllowed=true;
assert.equal((await post()).status,409);assert.equal(providerCalls,0);
// Hosted zero-byte streams must pass while any nonempty content fails closed.
const stream=bytes=>new ReadableStream({start(c){if(bytes)c.enqueue(new TextEncoder().encode(bytes));c.close();}});
const streamed=(bytes,length)=>rt(new Request(url,{method:"POST",headers:{origin:ORIGIN,authorization:"Bearer "+bearer,"content-length":length},body:stream(bytes),duplex:"half"}));
assert.equal((await streamed("x","0")).status,403);
assert.equal((await streamed(null,"1")).status,403);
assert.equal((await streamed(null,"0")).status,409);
assert.equal(providerCalls,0);
approved=true;
const api=createGmailAdminClient({allowed:()=>true,getBearer:async()=>bearer,request:(u,o)=>rt(new Request(u,{...o,headers:{...o.headers,origin:ORIGIN}}))});
assert.deepEqual(await api("sender-test"),{outcome:"accepted-not-delivered"});assert.equal(finished,"accepted-not-delivered");assert.equal(providerCalls,2);
assert.deepEqual(await api("sender-test"),{outcome:"not-authorized"});assert.equal(providerCalls,2);
console.log("PASS: exact sender test endpoint, fresh user proof, delivery locks, fixed recipient and test identity, no replay, no arbitrary request body");
