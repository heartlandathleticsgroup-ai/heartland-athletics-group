import {Buffer} from "node:buffer";
import assert from "node:assert/strict";
import {createReleaseRuntime} from "../release/gmail/runtime/runtime.mjs";
import {checkedDbOptions} from "../release/gmail/runtime/driver.mjs";
import {validEmail} from "../release/gmail/runtime/policy.mjs";
import {GMAIL_SCOPE} from "../release/gmail/runtime/policy.mjs";
import {CALLBACK_URI,CONTROL_BASE} from "../release/gmail/runtime/protocol.mjs";
const now=1000000,actor="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002",job="00000000-0000-4000-8000-000000000003",ticket="00000000-0000-4000-8000-000000000004";
const bearer="fictional.header.signature",clientId="fixture.apps.googleusercontent.com",clientSecret="fixture-client-secret",postalFooter="Fictional postal footer for isolated acceptance";
const origin="https://heartlandathleticsgroup.com",host="https://unrqbfngcgvqnytxbtgj.supabase.co",workerUrl=host+"/functions/v1/hag-gmail-worker",prefUrl=host+"/functions/v1/hag-subscriptions";
const ref="unrqbfngcgvqnytxbtgj",ca="-----BEGIN CERTIFICATE-----\nfictional\n-----END CERTIFICATE-----";
const dbUrl=login=>"postgresql://"+login+"."+ref+":fictional-password@aws-0-us-east-2.pooler.supabase.com:6543/postgres";
const config={runtime:"approved-runtime",oauth:true,send:true,preferences:true,clientId,clientSecret,postalFooter,publishableKey:"sb_publishable_fixture",controlDb:dbUrl("hag_gmail_control_login"),dispatchDb:dbUrl("hag_gmail_dispatch_login"),gatewayDb:dbUrl("hag_subscription_gateway_login"),ca,vault:{key:"0123456789abcdef".repeat(4),version:"one"},outbox:{key:"123456789abcdef0".repeat(4),version:"outbox"},workerKey:"23456789abcdef01".repeat(4)};
const opts=checkedDbOptions(config.controlDb,ca,"control");assert.equal(opts.options.ssl.rejectUnauthorized,true);assert.equal(opts.options.ssl.servername,"aws-0-us-east-2.pooler.supabase.com");assert.equal(opts.options.prepare,false);assert.equal(opts.options.max,1);
for(const url of [config.controlDb+"?sslmode=disable",config.controlDb.replace("aws-0-us-east-2.pooler.supabase.com","evil.invalid"),config.dispatchDb,config.controlDb.replace("6543","5432")])assert.throws(()=>checkedDbOptions(url,ca,"control"));
assert.throws(()=>checkedDbOptions(config.controlDb,"untrusted","control"));
assert.ok(validEmail("test+label@example.com"));for(const v of ["a..b@example.com","a,b@example.com","a@example.com\r\nBcc:x@example.com","a@-example.com","a@"+ "x".repeat(64)+".com"])assert.ok(!validEmail(v));
let connected=false,enabled=false,generation=0,cred=null,launch=null,state=null,flow=null,queued=false,reserved=false,finished=null,proofAllowed=true,sendCount=0,requestCount=0,driverCount=0,signups=0,enqueues=0;
const proof={gate:"authorized",sessionActive:true,actor,session,stepUpAt:now};
const roles={hag_gmail_control_login:"hag_gmail_control",hag_gmail_dispatch_login:"hag_gmail_dispatch",hag_subscription_gateway_login:"hag_subscription_runtime"};
const postgres=o=>{
 driverCount++;assert.equal(o.ssl.rejectUnauthorized,true);const login=o.username.split(".")[0],role=roles[login];
 return {async begin(fn){return fn({array:x=>x,unsafe:async(q,args=[])=>{
  if(q.includes("current_user"))return [{role,login,narrow:true}];
  if(!q.startsWith("select hag_private."))return [];
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
  else if(q.includes("gmail_disable")){enabled=false;generation++;launch=null;state=null;flow=null;v=args[0]?{credential:cred,key_version:"one"}:{};if(args[0]){connected=false;cred=null;}}
  else if(q.includes("gmail_claim"))v=enabled&&queued&&!reserved?{id:job,lease:ticket,key_version:"outbox"}:null;
  else if(q.includes("gmail_reserve")){if(enabled&&!reserved){reserved=true;v={id:job,ticket,generation,credential:cred,key_version:"one",message:{destination:"release-test@example.com",purpose:"manage",token:"a".repeat(64)}};}}
  else if(q.includes("gmail_dispatch_allowed"))v=enabled&&args[1]===generation;
  else if(q.includes("gmail_finish")){finished=args[1];v=true;}
  else if(q.includes("subscription_gateway_budget")){assert.equal(args[0],"edge-shared");v=true;}
  else if(q.includes("subscription_email_opt_in")){assert.equal(args[3],"release-test@example.com");signups++;v=null;}
  else if(q.includes("subscription_enqueue_email")){assert.equal(args[1],"access");assert.equal(args[4],"release-test@example.com");enqueues++;queued=true;v=null;}
  else if(q.includes("subscription_redeem")){v=args[1]==="manage"?{ok:true,channel:"email",suppressed:false,edit_token:"b".repeat(64),preferences:[{topic:"hag-announcements",status:"active"}]}:{ok:true};}
  else if(q.includes("subscription_edit")){v=true;}
  else throw Error("Unexpected fixture query");
  return [{value:v}];
 }});},async end(){}};
};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const fetcher=async(url,o)=>{
 requestCount++;assert.equal(o.redirect,"error");assert.equal(o.credentials,"omit");assert.ok(o.signal);
 if(url.endsWith("/rpc/hag_gmail_admin_proof")){assert.equal(o.headers.Authorization,"Bearer "+bearer);return json(proofAllowed?proof:null);}
 if(url==="https://oauth2.googleapis.com/token"){const p=new URLSearchParams(o.body);assert.equal(p.get("client_secret"),clientSecret);if(p.get("grant_type")==="authorization_code"){assert.equal(p.get("redirect_uri"),CALLBACK_URI);return json({access_token:"mock-access-token",token_type:"Bearer",expires_in:3600,scope:GMAIL_SCOPE,refresh_token:"mock-refresh-token"});}return json({access_token:"mock-access-token",token_type:"Bearer",expires_in:3600});}
 if(url==="https://oauth2.googleapis.com/revoke")return new Response(null,{status:200});
 if(url==="https://gmail.googleapis.com/gmail/v1/users/me/messages/send"){sendCount++;assert.equal(o.headers.Authorization,"Bearer mock-access-token");const raw=Buffer.from(JSON.parse(o.body).raw,"base64url").toString("utf8");assert.match(raw,/From: Heartland Athletics Group <no-reply@heartlandathleticsgroup.com>/);assert.match(raw,/Reply-To: info@heartlandathleticsgroup.com/);assert.match(raw,/To: release-test@example.com/);return json({id:"1abc456de78"});}
 throw Error("Unexpected network target");
};
const disabled=createReleaseRuntime({config:{runtime:"disabled"},postgres:()=>{throw Error("must not create driver");},fetcher:()=>{throw Error("must not fetch");}});assert.equal((await disabled.control(new Request(CONTROL_BASE))).status,503);
assert.equal(driverCount,0);assert.equal(requestCount,0);
const rt=createReleaseRuntime({config,postgres,fetcher,now:()=>now});assert.equal(driverCount,3);
const post=(route,headers={},body)=>rt.control(new Request(CONTROL_BASE+"/oauth/gmail/"+route,{method:"POST",headers:{origin,authorization:"Bearer "+bearer,...headers},body}));
const work=(secret=config.workerKey,headers={})=>rt.worker(new Request(workerUrl,{method:"POST",headers:{authorization:"Bearer "+secret,...headers}}));
const pref=(p,source=origin)=>rt.preferences(new Request(prefUrl+(p.action==="unsubscribe"?"/unsubscribe":""),{method:"POST",headers:{origin:source,"content-type":"application/json"},body:JSON.stringify(p)}));
assert.equal((await post("status",{origin:"https://evil.invalid"})).status,403);assert.equal(requestCount,0);
assert.equal((await work("0".repeat(64))).status,403);assert.equal((await work(config.workerKey,{origin})).status,403);assert.equal((await rt.worker(new Request(workerUrl,{method:"POST",headers:{authorization:"Bearer "+config.workerKey,"content-type":"application/json"},body:JSON.stringify({job:"untrusted"})}))).status,400);assert.equal(requestCount,0);
assert.deepEqual(await (await post("status")).json(),{connected:false,enabled:false});
const prep=await (await post("prepare")).json(),launched=await rt.control(new Request(prep.launchUrl,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant:prep.grant})}));
assert.equal(launched.status,303);const cookie=launched.headers.get("set-cookie").split(";")[0],google=new URL(launched.headers.get("location"));
assert.equal(google.origin,"https://accounts.google.com");assert.equal(google.pathname,"/o/oauth2/v2/auth");assert.equal(launched.headers.get("referrer-policy"),"no-referrer");assert.equal(launched.headers.get("cache-control"),"no-store");assert.equal(google.searchParams.get("access_type"),"offline");assert.equal(google.searchParams.get("include_granted_scopes"),"false");assert.equal(google.searchParams.has("grant"),false);assert.equal(google.searchParams.get("scope"),GMAIL_SCOPE);assert.equal(google.searchParams.get("redirect_uri"),CALLBACK_URI);assert.equal(google.searchParams.get("code_challenge_method"),"S256");assert.equal(google.searchParams.has("client_secret"),false);
const callback=await rt.control(new Request(CALLBACK_URI+"?state="+google.searchParams.get("state")+"&code=mock-auth-code",{headers:{cookie}}));
assert.equal(callback.status,303);assert.equal(callback.headers.get("location"),CONTROL_BASE+"/oauth/gmail/result?status=complete");assert.match(callback.headers.get("set-cookie"),/Max-Age=0/);
assert.deepEqual(await (await post("status")).json(),{connected:true,enabled:false});assert.equal(sendCount,0);
const off={enabled:false,destination:"",topics:[],consent:false},form={name:"Fictional subscriber",adult:true,email:{enabled:true,destination:"release-test@example.com",topics:["hag-announcements"],consent:true},sms:off};
assert.equal((await pref({action:"subscribe",requestId:job,version:"draft-3c3-v1",form})).status,503);assert.equal(signups,0);enabled=true;assert.equal((await pref({action:"subscribe",requestId:job,version:"draft-3c3-v1",form})).status,202);assert.equal(signups,1);assert.equal(enqueues,0);enabled=false;
assert.equal((await pref({action:"subscribe",requestId:job,version:"draft-3c3-v1",form:{...form,email:off,sms:{enabled:true,destination:"+12025550123",topics:["hag-announcements"],consent:true}}})).status,400);
assert.equal((await pref({action:"access",requestId:job,purpose:"manage",form:{channel:"email",destination:"release-test@example.com"}})).status,202);assert.equal(enqueues,1);
assert.deepEqual(await (await rt.worker(new Request(workerUrl,{method:"POST",headers:{authorization:"Bearer "+config.workerKey,"content-type":"application/json"},body:"{}"}))).json(),{outcome:"empty"});assert.equal(sendCount,0);
enabled=true;assert.deepEqual(await (await work()).json(),{outcome:"accepted-not-delivered"});assert.equal(finished,"accepted-not-delivered");assert.equal(sendCount,1);assert.deepEqual(await (await work()).json(),{outcome:"empty"});
assert.equal((await pref({action:"manage",token:"a".repeat(64)})).status,200);
assert.equal((await pref({action:"unsubscribe",token:"a".repeat(64)})).status,200);
proofAllowed=false;assert.equal((await post("disable")).status,403);proofAllowed=true;
assert.deepEqual(await (await post("disable")).json(),{enabled:false});assert.equal((await (await post("disconnect")).json()).providerRevoked,true);assert.equal(sendCount,1);
const locked=createReleaseRuntime({config:{...config,oauth:false,send:false,preferences:false},postgres,fetcher,now:()=>now});
const before=requestCount;assert.equal((await locked.control(new Request(CONTROL_BASE+"/oauth/gmail/prepare",{method:"POST",headers:{origin,authorization:"Bearer "+bearer}}))).status,503);
assert.equal((await locked.worker(new Request(workerUrl,{method:"POST",headers:{authorization:"Bearer "+config.workerKey}}))).status,503);assert.equal(requestCount,before);
await rt.close();await locked.close();
console.log("PASS: release runtime exact hosted routes, OAuth redirect/callback, TLS driver policy, private worker secret, email single opt-in and direct unsubscribe using mocks only");
