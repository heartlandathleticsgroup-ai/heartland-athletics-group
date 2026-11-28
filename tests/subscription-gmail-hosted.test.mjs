import assert from "node:assert/strict";
import {CALLBACK_URI,CONTROL_BASE,parseGrant,createProductionProtocol} from "../previews/subscriptions/server/gmail-production-protocol.mjs";
import {createHostedAcceptanceRuntime} from "../previews/subscriptions/server/gmail-hosted-acceptance.mjs";
import {createCredentialVault} from "../previews/subscriptions/server/gmail-backend.mjs";
import {GMAIL_SCOPE} from "../previews/subscriptions/server/gmail-preparation.mjs";
const now=1000000,actor="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002",job="00000000-0000-4000-8000-000000000003",ticket="00000000-0000-4000-8000-000000000004";
const bearer="fixture-admin-bearer",clientId="fixture.apps.googleusercontent.com",clientSecret="fixture-client-secret",postalFooter="Fictional postal footer for isolated acceptance";
const grant={access_token:"fixture-access-token",token_type:"Bearer",expires_in:3600,scope:GMAIL_SCOPE,refresh_token:"fixture-refresh-token"};
assert.equal(parseGrant({status:200,body:grant}).scope,GMAIL_SCOPE);
assert.equal(parseGrant({status:200,body:{...grant,scope:undefined}}),null);
assert.equal(parseGrant({status:200,body:{...grant,scope:GMAIL_SCOPE+" extra"}}),null);
assert.equal(parseGrant({status:200,body:{...grant,token_type:123}}),null);
const refresh={access_token:"fixture-access-token",token_type:"Bearer",expires_in:3600};
assert.equal(parseGrant({status:200,body:refresh},{refresh:true,previousScope:GMAIL_SCOPE}).scope,GMAIL_SCOPE);
assert.equal(parseGrant({status:200,body:refresh},{refresh:true}),null);
assert.equal(parseGrant({status:200,body:{...refresh,refresh_token:"fixture-rotated-token"}},{refresh:true,previousScope:GMAIL_SCOPE}),null);
let connected=false,enabled=false,generation=0,cred=null,launch=null,state=null,flow=null,queued=false,reserved=false,finished=null,proofAllowed=true,sendCount=0,requestCount=0;
const proof={gate:"authorized",sessionActive:true,actor,session,stepUpAt:now};
const vault=createCredentialVault({key:"a".repeat(64),version:"fixture"});
const makePool=(role,login)=>({async connect(){return {async query(q,args=[]){
 if(q.includes("current_user"))return {rows:[{role,login,narrow:true}]};
 if(!q.startsWith("select hag_private."))return {rows:[]};
 let v=null;
 if(q.includes("gmail_launch_put")){launch={d:args[0],ciphertext:args[3],generation};v=true;}
 else if(q.includes("gmail_launch_take")){if(launch?.d===args[0]&&launch.generation===generation){v=launch;launch=null;}}
 else if(q.includes("gmail_status"))v={connected,enabled,generation};
 else if(q.includes("gmail_begin_at_generation")){if(args[4]===generation){state={digest:args[0],verifier:args[3],generation};v=generation;}}
 else if(q.includes("gmail_flow_put")){flow={d:args[0],s:args[1],c:args[2]};v=true;}
 else if(q.includes("gmail_flow_take")){if(flow?.d===args[0]&&flow.s===args[1]){v=flow.c;flow=null;}}
 else if(q.includes("gmail_take")){if(state?.digest===args[0]&&args[1]===actor&&args[2]===session){v=state;state=null;}}
 else if(q.includes("gmail_store")){if(args[0]===generation){cred=args[1];connected=true;enabled=false;generation++;v=true;}}
 else if(q.includes("gmail_review_list"))v=[];
 else if(q.includes("gmail_disable")){enabled=false;generation++;launch=null;state=null;flow=null;v=args[0]?{credential:cred,key_version:"fixture"}:{};if(args[0]){connected=false;cred=null;}}
 else if(q.includes("gmail_claim"))v=enabled&&queued&&!reserved?{id:job,lease:ticket,key_version:"fixture"}:null;
 else if(q.includes("gmail_reserve")){if(enabled&&!reserved){reserved=true;v={id:job,ticket,generation,credential:cred,key_version:"fixture",message:{destination:"fixture@example.invalid",purpose:"manage",token:"a".repeat(64)}};}}
 else if(q.includes("gmail_dispatch_allowed"))v=enabled&&args[1]===generation;
 else if(q.includes("gmail_finish")){finished=args[1];v=true;}
 else throw Error("Unexpected fixture query");
 return {rows:[{value:v}]};},release(){}};}});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const fetchFixture=async(url,o)=>{
 requestCount++;assert.equal(o.redirect,"error");assert.equal(o.credentials,"omit");assert.ok(o.signal);
 if(url.endsWith("/rpc/hag_gmail_admin_proof")){assert.equal(o.headers.Authorization,"Bearer "+bearer);assert.equal(o.headers.apikey,"fixture-publishable-key");return json(proofAllowed?proof:null);}
 if(url==="https://oauth2.googleapis.com/token"){const p=new URLSearchParams(o.body);assert.equal(p.get("client_secret"),clientSecret);if(p.get("grant_type")==="authorization_code"){assert.equal(p.get("redirect_uri"),CALLBACK_URI);return json(grant);}return json(refresh);}
 if(url==="https://oauth2.googleapis.com/revoke")return new Response(null,{status:200});
 if(url==="https://gmail.googleapis.com/gmail/v1/users/me/messages/send"){sendCount++;assert.equal(o.headers.Authorization,"Bearer fixture-access-token");const raw=Buffer.from(JSON.parse(o.body).raw,"base64url").toString("utf8");assert.match(raw,/From: Heartland Athletics Group <no-reply@heartlandathleticsgroup.com>/);assert.match(raw,/Reply-To: info@heartlandathleticsgroup.com/);assert.ok(raw.includes(postalFooter));assert.ok(raw.includes("fixture@example.invalid"));return json({id:"1abc456de78"});}
 throw Error("Unexpected network target");
};
const options={mode:"isolated-acceptance",fetchFixture,publishableKey:"fixture-publishable-key",clientId,clientSecret,postalFooter,vault,outboxKeys:()=> "b".repeat(64),now:()=>now,controlPool:makePool("hag_gmail_control","hag_gmail_control_login"),dispatchPool:makePool("hag_gmail_dispatch","hag_gmail_dispatch_login")};
assert.throws(()=>createHostedAcceptanceRuntime({...options,mode:"production"}));
assert.throws(()=>createProductionProtocol({...options,fetchFixture:globalThis.fetch}));
const runtime=createHostedAcceptanceRuntime(options),origin="https://heartlandathleticsgroup.com";
const post=(name,headers={},body)=>runtime.handle(new Request(CONTROL_BASE+"/oauth/gmail/"+name,{method:"POST",headers:{origin,authorization:"Bearer "+bearer,...headers},body}));
const bad=await post("status",{origin:"https://evil.invalid"});assert.equal(bad.status,403);assert.equal(requestCount,0);
const preflight=await runtime.handle(new Request(CONTROL_BASE+"/oauth/gmail/status",{method:"OPTIONS",headers:{origin,"access-control-request-method":"POST","access-control-request-headers":"authorization"}}));assert.equal(preflight.status,204);assert.equal(preflight.headers.get("access-control-allow-origin"),origin);
assert.deepEqual(await (await post("status")).json(),{connected:false,enabled:false});
const prep=await post("prepare"),p=await prep.json();assert.equal(prep.headers.get("access-control-allow-origin"),origin);assert.equal(p.launchUrl,CONTROL_BASE+"/oauth/gmail/launch");
const launched=await runtime.handle(new Request(p.launchUrl,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant:p.grant})}));
assert.equal(launched.status,200);const cookie=launched.headers.get("set-cookie").split(";")[0];const parameters=(await launched.json()).parameters;assert.equal(parameters.redirect_uri,CALLBACK_URI);
const callback=await runtime.handle(new Request(CALLBACK_URI+"?state="+parameters.state+"&code=fixture-auth-code",{headers:{cookie}}));
assert.equal(callback.status,303);assert.equal(callback.headers.get("location"),CONTROL_BASE+"/oauth/gmail/result?status=complete");assert.match(callback.headers.get("set-cookie"),/Max-Age=0/);
assert.deepEqual(await (await post("status")).json(),{connected:true,enabled:false});assert.equal(sendCount,0);assert.equal(await runtime.pump(),"empty");
enabled=true;queued=true;assert.equal(await runtime.pump(),"accepted-not-delivered");assert.equal(sendCount,1);assert.equal(finished,"accepted-not-delivered");assert.equal(await runtime.pump(),"empty");
proofAllowed=false;assert.equal((await post("disable")).status,403);proofAllowed=true;assert.deepEqual(await (await post("disable")).json(),{enabled:false});assert.equal(await runtime.pump(),"empty");
assert.equal((await (await post("disconnect")).json()).providerRevoked,true);assert.equal(connected,false);
console.log("PASS: exact Supabase hosted routes, user-context RPC, static handoff/cookie/callback, real-shaped OAuth refresh response, fixed sender/footer, durable mock dispatch and admin disable");
