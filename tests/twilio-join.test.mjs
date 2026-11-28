import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createTwilioJoinFixture} from "../release/gmail/runtime/twilio-join.mjs";
import {VERSION} from "../release/gmail/runtime/sport-contract.mjs";
const code="a".repeat(24),number="+18005550123",id="00000000-0000-4000-8000-000000000001";
let ready=false,records=[],allow=true;
const join=createTwilioJoinFixture({mode:"isolated-acceptance",number,ready:async()=>ready,randomCode:()=>code,stage:async x=>{records.push(x);return allow;}});
const form={name:"Fixture",adult:true,email:{enabled:false},sms:{enabled:true,destination:"+12025550123",sports:["basketball"],updates:["general"],consent:true}};
const request={requestId:id,version:VERSION,form,catalog:["basketball"]};
await assert.rejects(join(request));assert.equal(records.length,0);ready=true;
await assert.rejects(join({...request,form:{...form,adult:false}}));await assert.rejects(join({...request,form:{...form,sms:{...form.sms,consent:false}}}));assert.equal(records.length,0);
const result=await join(request);assert.deepEqual(result,{number,command:"JOIN "+code,expiresMinutes:15});assert.equal(records[0].hash,createHash("sha256").update(code).digest("hex"));assert.equal(JSON.stringify(records[0]).includes(code),false);
allow=false;assert.deepEqual(await join(request),result); // generic, no existence disclosure
console.log("PASS: SMS confirmation instructions, adult consent, hash-only stage, US number, generic duplicate response and disabled provider gate");
