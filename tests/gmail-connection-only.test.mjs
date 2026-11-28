import assert from "node:assert/strict";
import {createConnectionOnly} from "../release/gmail/runtime/connection-only.mjs";
import {CONTROL_BASE,CALLBACK_URI} from "../release/gmail/runtime/protocol.mjs";
import {createGmailAdminClient,GMAIL_CONTROL_BASE} from "../admin/gmail-connection.mjs";
const origin="https://heartlandathleticsgroup.com",now=1000000,actor="00000000-0000-4000-8000-000000000001",session="00000000-0000-4000-8000-000000000002",bearer="fixture.header.signature";
const cfg={runtime:"approved-runtime",oauth:true,send:false,preferences:false,sportPreferences:false,clientId:"fixture.apps.googleusercontent.com",clientSecret:"fixture-client-secret",postalFooter:"Fictional postal footer for isolated acceptance",publishableKey:"sb_publishable_fixture",controlDb:"postgresql://hag_gmail_control_login.unrqbfngcgvqnytxbtgj:fictional-password@aws-0-us-east-2.pooler.supabase.com:6543/postgres",ca:"-----BEGIN CERTIFICATE-----\nfictional\n-----END CERTIFICATE-----",vault:{key:"0123456789abcdef".repeat(4),version:"one"}};
let connected=false,gen=0,launch,state,flow,credential,proofAllowed=true,drivers=0,requests=0;
const postgres=o=>{drivers++;assert.equal(o.username.split(".")[0],"hag_gmail_control_login");assert.equal(o.ssl.rejectUnauthorized,true);return {async begin(fn){return fn({unsafe:async(q,args=[])=>{
 if(q.includes("current_user"))return [{role:"hag_gmail_control",login:"hag_gmail_control_login",narrow:true}];
 if(!q.startsWith("select hag_private."))return [];
 let v;
 if(q.includes("gmail_status"))v={connected,enabled:false,generation:gen};
 else if(q.includes("gmail_launch_put")){launch={d:args[0],ciphertext:args[3],generation:gen};v=true;}
 else if(q.includes("gmail_launch_take")){v=launch?.d===args[0]?launch:null;launch=null;}
 else if(q.includes("gmail_begin_at_generation")){state={digest:args[0],verifier:args[3],generation:gen};v=gen;}
 else if(q.includes("gmail_flow_put")){flow={d:args[0],s:args[1],c:args[2]};v=true;}
 else if(q.includes("gmail_flow_take")){v=flow?.d===args[0]&&flow.s===args[1]?flow.c:null;flow=null;}
 else if(q.includes("gmail_take")){v=state?.digest===args[0]&&args[1]===actor&&args[2]===session?state:null;state=null;}
 else if(q.includes("gmail_store")){assert.equal(args[0],gen);credential=args[1];connected=true;gen++;v=true;}
 else if(q.includes("gmail_disable")){v={credential,key_version:"one"};connected=false;credential=null;gen++;}
 else throw Error("Unexpected DB call");return [{value:v}];
 }});},async end(){}};};
const json=x=>new Response(JSON.stringify(x),{headers:{"Content-Type":"application/json"}});
const fetcher=async(url,o)=>{requests++;if(url.endsWith("/rpc/hag_gmail_admin_proof"))return json(proofAllowed?{gate:"authorized",sessionActive:true,actor,session,stepUpAt:now}:null);
 if(url==="https://oauth2.googleapis.com/token"){assert.equal(new URLSearchParams(o.body).get("redirect_uri"),CALLBACK_URI);return json({access_token:"mock-access-token",token_type:"Bearer",expires_in:3600,scope:"https://www.googleapis.com/auth/gmail.send",refresh_token:"mock-refresh-token"});}
 if(url==="https://oauth2.googleapis.com/revoke")return new Response(null,{status:200});
 throw Error("Unexpected provider endpoint");
};
for(const flag of ["send","preferences","sportPreferences"])assert.throws(()=>createConnectionOnly({config:{...cfg,[flag]:true},postgres,fetcher}));
const disabled=createConnectionOnly({config:{...cfg,runtime:"disabled",oauth:false},postgres,fetcher});assert.equal((await disabled.handle(new Request(CONTROL_BASE+"/oauth/gmail/status"))).status,503);assert.equal(drivers,0);assert.equal(requests,0);
const rt=createConnectionOnly({config:cfg,postgres,fetcher,now:()=>now});assert.equal(drivers,1);
const post=(route,extra={})=>rt.handle(new Request(CONTROL_BASE+"/oauth/gmail/"+route,{method:"POST",headers:{origin,authorization:"Bearer "+bearer,...extra}}));
for(const route of ["enable","review","review-close","rotate","start","send","worker","subscriptions","x/status"])assert.equal((await post(route)).status,503);
assert.equal(requests,0);assert.equal((await post("status",{origin:"https://evil.invalid"})).status,403);
proofAllowed=false;assert.equal((await post("prepare")).status,403);proofAllowed=true;
assert.deepEqual(await (await post("status")).json(),{connected:false,enabled:false});
const p=await (await post("prepare")).json(),l=await rt.handle(new Request(p.launchUrl,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant:p.grant})}));
assert.equal(l.status,303);const target=new URL(l.headers.get("location")),cookie=l.headers.get("set-cookie").split(";")[0];assert.equal(target.origin,"https://accounts.google.com");assert.equal(target.searchParams.get("scope"),"https://www.googleapis.com/auth/gmail.send");assert.equal(target.searchParams.get("code_challenge_method"),"S256");
const cb=await rt.handle(new Request(CALLBACK_URI+"?state="+target.searchParams.get("state")+"&code=mock-auth-code",{headers:{cookie}}));assert.equal(cb.status,303);assert.equal(cb.headers.get("location"),CONTROL_BASE+"/oauth/gmail/result?status=complete");
assert.deepEqual(await (await post("status")).json(),{connected:true,enabled:false});
assert.equal((await (await post("disconnect")).json()).providerRevoked,true);
const api=createGmailAdminClient({allowed:()=>true,getBearer:async()=>bearer,request:(url,o)=>rt.handle(new Request(url,{...o,headers:{...o.headers,origin}}))});assert.deepEqual(await api("status"),{connected:false});await assert.rejects(api("enable"));await assert.rejects(api("rotate"));
await rt.close();
console.log("PASS: connection-only exact routes, one narrow DB identity, state/PKCE, encrypted grant, authenticated status and disconnect; no sending or subscription capability");
