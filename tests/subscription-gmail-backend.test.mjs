import assert from "node:assert/strict";
import {createCredentialVault,createGmailBackend,gmailControlDb,gmailDispatchDb} from "../previews/subscriptions/server/gmail-backend.mjs";
import {GMAIL_SCOPE} from "../previews/subscriptions/server/gmail-preparation.mjs";
const actor="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002",job="00000000-0000-4000-8000-000000000003",ticket="00000000-0000-4000-8000-000000000004";
const vault=createCredentialVault({key:"a".repeat(64),version:"fixture"}),sealed=vault.seal({token:"fixture-refresh-token"},"refresh");
assert.deepEqual(vault.open(sealed,"refresh"),{token:"fixture-refresh-token"});assert.throws(()=>vault.open(sealed,"state"));assert.throws(()=>createCredentialVault({key:"b".repeat(64),version:"fixture"}).open(sealed,"refresh"));
assert.throws(()=>vault.open(sealed.slice(0,-5)+"abcde","refresh"));assert.notEqual(sealed,vault.seal({token:"fixture-refresh-token"},"refresh"));
let clock=1000000,admin={actor,session,gate:"authorized",sessionActive:true,stepUpAt:clock},generation=0,connected=false,enabled=false,state=null,credential=null,queued=false,reserved=false,started=false,outcomes=[],calls=[],badScope=false,ambiguous=false,disableDuringRefresh=false;
const control={
 async status(){return {connected,enabled,generation};},
 async begin(d,a,s,v){state={d,a,s,v,generation,expires:clock+300000};return generation;},
 async take(d,a,s){if(!state||state.d!==d||state.a!==a||state.s!==s||state.generation!==generation||state.expires<=clock)return null;const result={generation,verifier:state.v};state=null;return result;},
 async store(g,c,v){if(g!==generation||connected)return false;connected=true;enabled=false;credential=c;generation++;return true;},
 async disable(disconnect){enabled=false;generation++;state=null;const old=credential;if(disconnect){credential=null;connected=false;}return disconnect?{credential:old,key_version:"fixture"}:{};}
};
const dispatch={
 async claim(){return enabled&&queued&&!reserved?{id:job,lease:ticket,key_version:"fixture"}:null;},
 async reserve(){if(!enabled||reserved)return null;reserved=true;return {id:job,ticket,generation,credential,key_version:"fixture",message:{destination:"fixture@example.invalid",purpose:"manage",token:"a".repeat(64)}};},
 async allowed(t,g){if(!enabled||g!==generation||started)return false;started=true;return true;},
 async finish(t,o){outcomes.push(o);return true;}
};
const fixtureRequest=async x=>{calls.push(x);assert.equal(x.method,"POST");assert.equal(x.redirect,"error");assert.equal(x.timeoutMs,5000);
 if(x.url==="https://oauth2.googleapis.com/token"){const p=new URLSearchParams(x.body);assert.equal(p.get("client_secret"),"fixture-client-secret");
 if(p.get("grant_type")==="authorization_code"){assert.equal(p.get("redirect_uri"),"https://preview.invalid/oauth/gmail/callback");assert.match(p.get("code_verifier"),/^[A-Za-z0-9_-]{43}$/);return {status:200,body:{scope:badScope?GMAIL_SCOPE+" extra":GMAIL_SCOPE,token_type:"Bearer",access_token:"fixture-access-token",refresh_token:"fixture-refresh-token",expires_in:3600}};}
 if(disableDuringRefresh)await control.disable(false);
 return {status:200,body:{scope:GMAIL_SCOPE,token_type:"Bearer",access_token:"fixture-access-token",expires_in:3600}};}
 if(x.url==="https://oauth2.googleapis.com/revoke")return {status:200};
 assert.equal(x.url,"https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
 assert.equal(x.headers.Authorization,"Bearer fixture-access-token");assert.match(Buffer.from(JSON.parse(x.body).raw,"base64url").toString(),/To: fixture@example.invalid/);
 if(ambiguous)throw Error("simulated timeout");return {status:200,body:{id:"fixture-message-id"}};
};
const opts={mode:"isolated-test",control,dispatch,vault,verifyAdmin:async()=>admin,fixtureRequest,clientId:"fixture.apps.googleusercontent.com",clientSecret:"fixture-client-secret",outboxKeys:()=> "b".repeat(64),now:()=>clock};
assert.throws(()=>createGmailBackend({...opts,mode:"production"}));assert.throws(()=>createGmailBackend({...opts,clientId:"real.apps.googleusercontent.com"}));
const backend=createGmailBackend(opts);
const post=(name,origin="https://preview.invalid")=>new Request("https://preview.invalid/oauth/gmail/"+name,{method:"POST",headers:{origin}});
const start=async()=>{const res=await backend.handle(post("start"));assert.equal(res.status,200);return (await res.json()).parameters;};
const cb=s=>new Request("https://preview.invalid/oauth/gmail/callback?state="+s+"&code=fixture-auth-code");
assert.equal((await backend.handle(post("start","https://evil.invalid"))).status,403);
admin.stepUpAt=0;assert.equal((await backend.handle(post("start"))).status,403);admin.stepUpAt=clock;
let p=await start();assert.equal(p.scope,GMAIL_SCOPE);assert.equal(calls.length,0);assert.ok(!state.v.includes("fixture"));
admin.session=actor;assert.equal((await backend.handle(cb(p.state))).status,400);admin.session=session;
badScope=true;assert.equal((await backend.handle(cb(p.state))).status,400);assert.equal(connected,false);assert.equal((await backend.handle(cb(p.state))).status,400);
badScope=false;p=await start();clock+=300001;admin.stepUpAt=clock;assert.equal((await backend.handle(cb(p.state))).status,400);
p=await start();assert.deepEqual(await (await backend.handle(cb(p.state))).json(),{connected:true,enabled:false});assert.equal((await backend.handle(cb(p.state))).status,400);assert.ok(!credential.includes("fixture-refresh-token"));
assert.deepEqual(await (await backend.handle(post("status"))).json(),{connected:true,enabled:false});assert.equal(await backend.pump(),"empty");
enabled=true;queued=true;assert.equal(await backend.pump(),"accepted-not-delivered");assert.equal(await backend.pump(),"empty");
reserved=false;started=false;ambiguous=true;assert.equal(await backend.pump(),"ambiguous-hold-no-resend");assert.equal(await backend.pump(),"empty");
reserved=false;started=false;ambiguous=false;disableDuringRefresh=true;const count=calls.filter(c=>c.url.includes("/messages/send")).length;assert.equal(await backend.pump(),"permanent-or-configuration-review");assert.equal(calls.filter(c=>c.url.includes("/messages/send")).length,count);
assert.deepEqual(await (await backend.handle(post("disable"))).json(),{enabled:false});
assert.deepEqual(await (await backend.handle(post("disconnect"))).json(),{connected:false,enabled:false,providerRevoked:true});assert.equal(credential,null);
const queries=[];const q=async(sql,args)=>{queries.push({sql,args});return {rows:[{value:true}]};};await gmailControlDb(q).begin("a".repeat(64),actor,session,sealed);await gmailDispatchDb(q).allowed(ticket,1,{destination:"fixture@example.invalid",purpose:"manage",token:"a".repeat(64)});assert.equal(queries.length,2);assert.ok(queries.every(x=>x.sql.includes("$1")));
console.log("PASS: isolated OAuth callback, fresh admin/session, state expiry/replay, scope rejection, AES-GCM tamper rejection, status, disconnect, disabled dispatch and ambiguous send hold");

const {createAdminProofVerifier,createGmailStagedRuntime}=await import("../previews/subscriptions/server/gmail-runtime.mjs");
let rpcCalls=[];
const verifier=createAdminProofVerifier({resolveSession:async()=>({bearer:"fixture-admin-bearer"}),userRpc:async x=>{rpcCalls.push(x);return {data:admin};}});
assert.deepEqual(await verifier(post("status")),admin);assert.equal(rpcCalls[0].name,"hag_gmail_admin_proof");assert.equal(rpcCalls[0].bearer,"fixture-admin-bearer");
assert.equal(await createAdminProofVerifier({resolveSession:async()=>({bearer:"untrusted"}),userRpc:async()=>{throw Error("must not run");}})(post("status")),null);
const poolCalls=[];
const makePool=(role,login)=>({async connect(){return {async query(q,args){poolCalls.push(q);if(q.includes("current_user"))return {rows:[{role,login,narrow:true}]};if(q.includes("gmail_status"))return {rows:[{value:{connected:false,enabled:false}}]};if(q.includes("gmail_claim"))return {rows:[{value:null}]};return {rows:[]};},release(){}};}});
const cp=makePool("hag_gmail_control","hag_gmail_control_login"),dp=makePool("hag_gmail_dispatch","hag_gmail_dispatch_login");
const runtime=createGmailStagedRuntime({...opts,controlPool:cp,dispatchPool:dp,resolveSession:async()=>({bearer:"fixture-admin-bearer"}),userRpc:async()=>({data:admin})});
assert.deepEqual(await (await runtime.handle(post("status"))).json(),{connected:false,enabled:false});
assert.equal(await runtime.pump(),"empty");assert.ok(poolCalls.includes("SET LOCAL ROLE hag_gmail_control"));assert.ok(poolCalls.includes("SET LOCAL ROLE hag_gmail_dispatch"));
assert.throws(()=>createGmailStagedRuntime({...opts,controlPool:cp,dispatchPool:cp,resolveSession:async()=>null,userRpc:async()=>null}));
console.log("PASS: user-context admin proof and isolated bounded Gmail control/dispatch runtime");
