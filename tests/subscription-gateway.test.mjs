import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {createGateway,createSimulatedDelivery,GENERIC} from "../previews/subscriptions/server/gateway.mjs";
import {postgresAdapter} from "../previews/subscriptions/server/postgres-adapter.mjs";
import {CONSENT_VERSION} from "../previews/subscriptions/consent.mjs";
const origin="https://heartlandathleticsgroup.com",url="https://stage.invalid/subscriptions";
const capture=createSimulatedDelivery(),claimed=new Set(),tokens=new Map(),calls=[];
let allowed=true,ingressAllowed=true,src="192.0.2.1",throwIssue=false;
const db={
 async budget(s,a){calls.push(["budget",s,a]);return allowed;},
 async issue(id,a,i){calls.push(["issue",id,a,i.channel]);if(throwIssue)throw Error("simulated unavailable");const k=id+":"+i.channel;if(claimed.has(k)||i.destination==="unknown@example.invalid")return null;claimed.add(k);await Promise.resolve();const t=randomBytes(32).toString("hex");tokens.set(t,i.purpose);return t;},
 async redeem(t,p){if(tokens.get(t)!==p)return null;tokens.delete(t);return p==="manage"?{channel:"email",suppressed:false,preferences:[{topic:"hag-announcements",status:"active",private:"do not leak"}],edit_token:randomBytes(32).toString("hex"),private:"do not leak"}:{ok:true};},
 async edit(){return true;}
};
const gateway=createGateway({db,delivery:capture,source:()=>src,ingress:async()=>ingressAllowed});
const req=(x,opts={})=>new Request(url,{method:"POST",headers:{origin,"content-type":"application/json",...opts.headers},body:JSON.stringify(x),...opts,...(opts.headers?{headers:{origin,"content-type":"application/json",...opts.headers}}:{})});
const off={enabled:false,destination:"",topics:[],consent:false};
const form={name:"Fixture",adult:true,email:{enabled:true,destination:"fixture@example.invalid",topics:["hag-announcements"],consent:true},sms:off};
const sub={action:"subscribe",requestId:randomUUID(),version:CONSENT_VERSION,form};
const access={action:"access",requestId:randomUUID(),purpose:"manage",form:{channel:"email",destination:"fixture@example.invalid"}};
const generic=async r=>{assert.equal(r.status,202);assert.deepEqual(await r.json(),{message:GENERIC});assert.equal(r.headers.get("cache-control"),"no-store");};
await Promise.all(Array.from({length:20},()=>gateway(req(sub)).then(generic)));
let issued=capture.drain();assert.equal(issued.length,1);const t=issued[0].token;
let rs=await Promise.all(Array.from({length:10},()=>gateway(req({action:"confirm",token:t})).then(r=>r.json())));assert.equal(rs.filter(x=>x.ok).length,1);
await generic(await gateway(req(access)));issued=capture.drain();assert.equal(issued.length,1);
let result=await gateway(req({action:"manage",token:issued[0].token})).then(r=>r.json());assert.equal(result.ok,true);assert.equal(result.private,undefined);assert.deepEqual(result.preferences,[{topic:"hag-announcements",status:"active"}]);assert.match(result.editToken,/^[0-9a-f]{64}$/);
await generic(await gateway(req({...access,requestId:randomUUID(),form:{channel:"email",destination:"unknown@example.invalid"}})));assert.equal(capture.drain().length,0);
allowed=false;await generic(await gateway(req({...sub,requestId:randomUUID()})));allowed=true;
throwIssue=true;await generic(await gateway(req({...sub,requestId:randomUUID()})));throwIssue=false;
assert.equal((await gateway(req(sub,{headers:{origin:"https://evil.invalid"}}))).status,403);
assert.equal((await gateway(new Request(url,{method:"GET",headers:{origin}}))).status,405);
assert.equal((await gateway(new Request(url,{method:"OPTIONS",headers:{origin,"access-control-request-method":"POST","access-control-request-headers":"content-type"}}))).status,204);
assert.equal((await gateway(req(sub,{headers:{"content-type":"text/plain"}}))).status,400);
assert.equal((await gateway(req(sub,{headers:{"content-length":"9000"}}))).status,400);
assert.equal((await gateway(req({...sub,form:{...form,name:"x".repeat(9000)}}))).status,400);
assert.equal((await gateway(req({...sub,form:{...form,adult:false}}))).status,400);
assert.equal((await gateway(req({...sub,form:{...form,email:{...form.email,consent:false}}}))).status,400);
assert.equal((await gateway(req({...sub,form:{...form,email:{...form.email,destination:"real@example.com"}}}))).status,400);
assert.equal((await gateway(req({...sub,version:"old"}))).status,400);
assert.equal((await gateway(req({...sub,role:"service_role"}))).status,400);
assert.equal((await gateway(req({action:"manage",token:"bad"}))).status,400);
assert.equal((await gateway(req({action:"edit",token:result.editToken,add:["hag-announcements"],remove:[],adult:true,consent:false,version:CONSENT_VERSION}))).status,400);
assert.equal((await gateway(req({action:"edit",token:result.editToken,add:["hag-announcements"],remove:["hag-announcements"],adult:true,consent:true,version:CONSENT_VERSION}))).status,400);
assert.equal((await gateway(req({action:"edit",token:result.editToken,add:[],remove:["hag-announcements"],adult:false,consent:false,version:CONSENT_VERSION}))).status,200);
ingressAllowed=false;assert.equal((await gateway(req(sub))).status,429);ingressAllowed=true;src=null;assert.equal((await gateway(req(sub))).status,503);src="192.0.2.1";
await generic(await gateway(req({...sub,requestId:randomUUID()},{headers:{"x-forwarded-for":"attacker"}})));assert.equal(calls.filter(c=>c[0]==="budget").at(-1)[1],src);
const queries=[];const adapter=postgresAdapter(async(q,args)=>{queries.push([q,args]);return {rows:[{value:true}]};});
await adapter.budget(src,"subscribe");await adapter.issue(randomUUID(),"subscribe",{channel:"email",destination:"fixture@example.invalid",name:"Fixture",adult:true,topics:["hag-announcements"],consentText:"canonical",consentVersion:CONSENT_VERSION,purpose:"confirm"});await adapter.redeem("x","confirm");await adapter.edit({token:"x",add:[],remove:["hag-announcements"],adult:false,consent:false,version:CONSENT_VERSION});
assert.equal(queries.length,4);assert.ok(queries.every(([q,args])=>q.includes("$1")&&Array.isArray(args)&&!q.includes("fixture@example.invalid")));
console.log("Gateway tests passed: mock concurrent issuance/replay, validation, origin, bounds, generic responses, verified projection and fixed SQL.");
