import assert from "node:assert/strict";
import {makeSignup,SIGNUP_RELEASE_ENABLED,sendSignup} from "../subscribe/signup.mjs";
import {PREFERENCE_RELEASE_ENABLED,parseFragment} from "../preferences/preferences.mjs";
import {createProductionProtocol} from "../release/gmail/runtime/protocol.mjs";
import {Buffer} from "node:buffer";
import {readFileSync} from "node:fs";
const id="11111111-1111-4111-8111-111111111111",token="a".repeat(64),v={name:"Example Adult",adult:true,email:"test@example.invalid",topics:["hag-announcements"],consent:true};
assert.equal(SIGNUP_RELEASE_ENABLED,false);assert.equal(PREFERENCE_RELEASE_ENABLED,false);
assert.throws(()=>makeSignup({...v,adult:false},id));assert.throws(()=>makeSignup({...v,consent:false},id));assert.throws(()=>makeSignup({...v,topics:[]},id));
assert.equal(makeSignup(v,id).form.sms.enabled,false);
await assert.rejects(sendSignup(makeSignup(v,id)),/unavailable/i);
assert.equal(parseFragment("#unsubscribe:"+token).purpose,"unsubscribe");
let transport=0;const p=createProductionProtocol({mode:"release-candidate",fetchFixture:async()=>{transport++;throw Error("Network denied")},clientId:"fixture.apps.googleusercontent.com",clientSecret:"fixture-secret",postalFooter:"Fixture Postal Address, Test City",network:{oauth:false,send:false}});
const msg=p.render({id,destination:v.email,purpose:"welcome",token});const raw=Buffer.from(msg.raw,"base64url").toString("utf8");
for(const s of ["From: Heartland Athletics Group <no-reply@heartlandathleticsgroup.com>","Reply-To: info@heartlandathleticsgroup.com","Please add no-reply@heartlandathleticsgroup.com","/preferences/#unsubscribe:"+token,"/privacy/","Fixture Postal Address, Test City","No activation step is needed"])assert.ok(raw.includes(s),s);
await assert.rejects(p.request({url:"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",method:"POST",headers:{Authorization:"Bearer fixture-token"},body:JSON.stringify(msg)}));
assert.equal(transport,0);
for(const path of ["index.html","gus-macker/index.html","contact/index.html"]){assert.ok(readFileSync(path,"utf8").includes('href="/subscribe/"'),path)}
assert.ok(readFileSync("contact/index.html","utf8").includes("https://formspree.io/f/mrednprl"));
for(const path of ["privacy/index.html","terms/index.html","sms-terms/index.html"]){assert.ok(readFileSync(path,"utf8").includes("not yet effective"),path)}
console.log("Subscriber consent, disabled launch flags, welcome rendering and public links passed");
