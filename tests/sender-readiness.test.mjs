import assert from "node:assert/strict";
import {Buffer} from "node:buffer";
import {createSenderTest,renderSenderTest} from "../release/gmail/runtime/sender-test.mjs";
import {createCredentialVault} from "../release/gmail/runtime/backend.mjs";
const id="00000000-0000-4000-8000-000000000001",to="jhawkins@heartlandathleticsgroup.com",postalFooter="Fixture mailing address, Example, IL 00000",now=1000000;
const vault=createCredentialVault({key:"0123456789abcdef".repeat(4),version:"fixture"});let approved=false,claimed=false,outcome=null,calls=0,fail=false;
const proof={gate:"authorized",sessionActive:true,actor:"00000000-0000-4000-8000-000000000002",session:"00000000-0000-4000-8000-000000000003",stepUpAt:now};
const options={mode:"single-sender-test",vault,clientId:"fixture.apps.googleusercontent.com",clientSecret:"fixture-secret",postalFooter,now:()=>now,
 verifyAdmin:async bearer=>bearer==="fixture-admin"?proof:null,
 claim:async testId=>{if(!approved||claimed||testId!==id)return null;claimed=true;return {testId:id,generation:1,recipient:to,keyVersion:"fixture",credential:vault.seal({token:"fixture-refresh"},"refresh")};},
 start:async(testId,generation)=>testId===id&&generation===1&&claimed,
 finish:async(testId,v)=>{assert.equal(testId,id);outcome=v;return true;},
 fetchFixture:async(url,opts)=>{calls++;assert.equal(opts.redirect,"error");assert.equal(opts.credentials,"omit");if(url.endsWith("/token"))return new Response(JSON.stringify({access_token:"fixture-access-token",expires_in:3600,token_type:"Bearer"}),{headers:{"Content-Type":"application/json"}});assert.equal(url,"https://gmail.googleapis.com/gmail/v1/users/me/messages/send");const raw=Buffer.from(JSON.parse(opts.body).raw,"base64url").toString("utf8");assert.match(raw,/From: Heartland Athletics Group <no-reply@heartlandathleticsgroup.com>/);assert.match(raw,/Reply-To: info@heartlandathleticsgroup.com/);assert.ok(raw.includes("To: "+to));assert.ok(raw.includes(postalFooter));assert.doesNotMatch(raw,/\/preferences\/|Bcc:|Cc:/);if(fail)throw Error("Synthetic timeout");return new Response(JSON.stringify({id:"fixture-message"}),{headers:{"Content-Type":"application/json"}});}
};
assert.throws(()=>renderSenderTest({id,to:"other@example.com",postalFooter}));assert.throws(()=>renderSenderTest({id,to,postalFooter:"bad\r\nBcc: malicious@example.com"}));
assert.throws(()=>createSenderTest({...options,mode:"production"}));
const run=createSenderTest(options);
assert.equal(await run({testId:id,bearer:"fixture-admin"}),"not-authorized");assert.equal(calls,0);approved=true;
assert.equal(await run({testId:id,bearer:"unverified"}),"not-authorized");assert.equal(calls,0);
assert.equal(await run({testId:id,bearer:"fixture-admin"}),"accepted-not-delivered");assert.equal(outcome,"accepted-not-delivered");assert.equal(calls,2);
assert.equal(await run({testId:id,bearer:"fixture-admin"}),"not-authorized");assert.equal(calls,2);
claimed=false;fail=true;
assert.equal(await run({testId:id,bearer:"fixture-admin"}),"ambiguous-hold-no-resend");assert.equal(calls,4);
assert.equal(await run({testId:id,bearer:"fixture-admin"}),"not-authorized");assert.equal(calls,4);
claimed=false;fail=false;
const denied=createSenderTest({...options,start:async()=>false});assert.equal(await denied({testId:id,bearer:"fixture-admin"}),"authorization-required");assert.equal(calls,5);
console.log("PASS: fixture-only owner-approved single recipient, exact sender and reply-to, no subscriber links, one attempt, provider acceptance is not delivery, ambiguous failure never retried");
