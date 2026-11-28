import assert from "node:assert/strict";
import {createGmailAdapter,durableEmailAdapter,durableEmailWorker} from "../previews/subscriptions/server/durable-email.mjs";
const r=createGmailAdapter();assert.equal(r.enabled,false);await assert.rejects(r.send(),/disabled/);
const calls=[],query=async(q,args)=>{calls.push([q,args]);return {rows:[{value:q.includes("claim")?{id:"job",lease:"lease",key_version:"fixture"}:"accepted"}]};};
const a=durableEmailAdapter(query,"a".repeat(64),"fixture");await a.enqueue("id","access",{channel:"email",destination:"fixture@example.invalid",purpose:"manage"});await assert.rejects(a.enqueue("id","subscribe",{channel:"email",destination:"fixture@example.invalid",purpose:"confirm"}));assert.equal(r.scope,"https://www.googleapis.com/auth/gmail.send");assert.equal(r.replyTo,"info@heartlandathleticsgroup.com");
assert.ok(calls[0][0].includes("$11"));await assert.rejects(a.enqueue("id","subscribe",{channel:"email",destination:"real@example.com"}));
const w=durableEmailWorker(query,()=> "a".repeat(64));assert.equal(await w.pump(),"accepted");
assert.equal(await durableEmailWorker(query,()=>null).pump(),"accepted");assert.equal(calls.at(-1)[1][2],null);
console.log("PASS: disabled Gmail and isolated fixed-query outbox adapters");
