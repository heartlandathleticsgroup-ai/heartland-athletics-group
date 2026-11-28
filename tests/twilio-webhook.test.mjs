import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {createTwilioInboundFixture,TWILIO_INBOUND,classifyInbound} from "../release/gmail/runtime/twilio-webhook.mjs";
const accountSid="AC"+"a".repeat(32),serviceSid="MG"+"b".repeat(32),number="+18005550123",authToken="fixtureAuthToken1234567890123456";
let ready=false,events=[];
const route=createTwilioInboundFixture({mode:"isolated-acceptance",accountSid,serviceSid,number,authToken,ready:async()=>ready,record:async e=>{events.push(e);return true;}});
const request=(body,extra={},signatureOverride=null)=>{
 const p=new URLSearchParams({AccountSid:accountSid,MessagingServiceSid:serviceSid,MessageSid:"SM"+"c".repeat(32),From:"+12025550123",To:number,Body:body,...extra});
 const signature=createHmac("sha1",authToken).update(TWILIO_INBOUND+[...p.keys()].sort().map(k=>k+p.get(k)).join("")).digest("base64");
 return new Request(TWILIO_INBOUND,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-twilio-signature":signatureOverride??signature},body:p});
};
assert.throws(()=>createTwilioInboundFixture({mode:"production",accountSid,serviceSid,number,authToken,ready:()=>true,record:()=>true}));
assert.equal((await route(request("STOP",{},"invalid"))).status,403);assert.equal(events.length,0);
assert.equal((await route(request("STOP",{AccountSid:"AC"+"d".repeat(32)}))).status,403);
assert.equal((await route(request("JOIN "+"a".repeat(24)))).status,200);assert.equal(events.length,0);
ready=true;assert.equal((await route(request("JOIN "+"a".repeat(24)))).status,200);assert.equal(events.at(-1).kind,"join");
for(const keyword of ["STOP","QUIT","END","REVOKE","OPT OUT","CANCEL","UNSUBSCRIBE"]){assert.equal((await route(request(keyword))).status,200);assert.equal(events.at(-1).kind,"stop");}
ready=false;assert.equal((await route(request("START",{OptOutType:"START"}))).status,200);assert.equal(events.at(-1).kind,"start");
assert.equal(await (await route(request("HELP",{OptOutType:"HELP"}))).text(),"<Response/>");assert.equal(events.at(-1).kind,"help");
assert.equal(classifyInbound("please stop texting me",null).kind,"review");
assert.equal(classifyInbound("JOIN "+"a".repeat(24),"STOP").kind,"stop");
console.log("PASS: Twilio signed form, account/service/number binding, no outbound messages, opt-out while paused, JOIN requires readiness and START never enrolls");
