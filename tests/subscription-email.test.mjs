import assert from "node:assert/strict";
import {renderTestEmail} from "../previews/subscriptions/server/email-templates.mjs";
import {createEmailSimulation} from "../previews/subscriptions/server/email-simulation.mjs";
let now=1000000,allowed=true,checks=0;
const fixture=(token,purpose="confirm")=>({channel:"email",destination:"fixture@example.invalid",purpose,token:token.repeat(64),issuedAt:now});
for(const purpose of ["confirm","manage","unsubscribe"]){
 const m=renderTestEmail(fixture("a",purpose));assert.match(m.text,/https:\/\/preview\.invalid\/preferences#/);assert.match(m.html,/href="https:\/\/preview\.invalid\/preferences#/);assert.doesNotMatch(m.html,/<img|<script|utm_/i);
}
assert.throws(()=>renderTestEmail({...fixture("a"),destination:"user@example.com"}));
assert.throws(()=>renderTestEmail({...fixture("a"),token:'<script>'}));
const q=createEmailSimulation({now:()=>now,eligible:async()=>{checks++;return allowed;},script:["ambiguous","transient","permanent"]});
const a=fixture("a");
await Promise.all(Array.from({length:8},()=>q.accept(a)));assert.equal(q.stats().length,1);
await assert.rejects(q.accept({...a,purpose:"manage"}));
await Promise.all([q.pump(),q.pump()]);assert.equal(q.acceptedCount(),1);assert.equal(q.stats()[0].state,"retry");assert.equal(q.stats()[0].attempts,1);
now+=30000;await q.pump();assert.equal(q.acceptedCount(),1);assert.equal(q.stats()[0].state,"accepted");assert.equal(q.stats()[0].payloadRetained,false);
assert.equal(checks,2);await q.accept(a);await q.pump();assert.equal(q.acceptedCount(),1);
await q.accept(fixture("b"));await q.pump();assert.equal(q.stats()[1].state,"retry");allowed=false;now+=30000;await q.pump();assert.equal(q.stats()[1].state,"cancelled");assert.equal(q.stats()[1].payloadRetained,false);
allowed=true;await q.accept(fixture("c","manage"));await q.pump();assert.equal(q.stats()[2].state,"failed");
await q.accept(fixture("d"));now+=16*60000;await q.pump();assert.equal(q.stats()[3].state,"expired");
assert.ok(!JSON.stringify(q.stats()).includes("fixture@example.invalid"));assert.ok(!JSON.stringify(q.stats()).includes(a.token));
now+=86400000;assert.equal(q.stats().length,0);q.close();await assert.rejects(q.accept(fixture("e")));
const errors=createEmailSimulation({now:()=>now,eligible:async()=>{throw Error("private");}});
await errors.accept(fixture("f"));for(let i=0;i<3;i++){await errors.pump();now+=300000;}
assert.equal(errors.stats()[0].state,"failed");assert.equal(errors.acceptedCount(),0);errors.close();
console.log("PASS: transactional templates, encrypted queue, duplicate enqueue, ambiguous acknowledgement retry, cancellation, expiry, failure and retention");
