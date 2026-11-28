// E.9 release candidate, not deployed. Real network gated by private configuration.
import {createCipheriv,createDecipheriv,randomBytes,createHash} from "node:crypto";
import {Buffer} from "node:buffer";
import {GMAIL_SCOPE,scopeIsSendOnly,classifyGmailOutcome,safeToken} from "./policy.mjs";
import {createAuthorizationPlan} from "./authorization.mjs";
const TOKEN="https://oauth2.googleapis.com/token",REVOKE="https://oauth2.googleapis.com/revoke",SEND="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const CALLBACK="https://preview.invalid/oauth/gmail/callback";
const ORIGIN="https://preview.invalid";
const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const digest=x=>createHash("sha256").update(x).digest("hex");
const secret=safeToken;
const b64=x=>Buffer.from(x,"base64url");
export function createCredentialVault({key,version}){
 if(typeof key!=="string"||!/^[0-9a-f]{64}$/.test(key)||typeof version!=="string"||!/^[A-Za-z0-9_-]{1,32}$/.test(version))throw Error("Invalid vault configuration");
 const k=Buffer.from(key,"hex");
 return Object.freeze({version,seal(value,aad){const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",k,iv);c.setAAD(Buffer.from(version+":"+aad));const enc=Buffer.concat([c.update(JSON.stringify(value),"utf8"),c.final()]);return [iv,c.getAuthTag(),enc].map(x=>x.toString("base64url")).join(".");},
 open(value,aad){if(typeof value!=="string"||value.length>16384)throw Error("Invalid encrypted record");const parts=value.split(".");if(parts.length!==3||parts.some(x=>!/^[A-Za-z0-9_-]+$/.test(x)))throw Error("Invalid encrypted record");const [iv,tag,enc]=parts.map(b64);if(iv.length!==12||tag.length!==16)throw Error("Invalid encrypted record");const d=createDecipheriv("aes-256-gcm",k,iv);d.setAAD(Buffer.from(version+":"+aad));d.setAuthTag(tag);return JSON.parse(Buffer.concat([d.update(enc),d.final()]).toString("utf8"));}});
}
export function gmailControlDb(query){
 const scalar=async(sql,args)=>{const r=await query(sql,args);if(r?.rows?.length!==1)throw Error("Database unavailable");return r.rows[0].value;};
 return {begin:(d,a,s,v)=>scalar("select hag_private.gmail_begin($1,$2::uuid,$3::uuid,$4) as value",[d,a,s,v]),
 beginAtGeneration:(d,a,s,v,g)=>scalar("select hag_private.gmail_begin_at_generation($1,$2::uuid,$3::uuid,$4,$5::bigint) as value",[d,a,s,v,g]),
 take:(d,a,s)=>scalar("select hag_private.gmail_take($1,$2::uuid,$3::uuid) as value",[d,a,s]),
 store:(g,c,v)=>scalar("select hag_private.gmail_store($1::bigint,$2,$3) as value",[g,c,v]),
 status:()=>scalar("select hag_private.gmail_status() as value",[]),
 disable:d=>scalar("select hag_private.gmail_disable($1) as value",[d]),
 rotationRead:()=>scalar("select hag_private.gmail_rotation_read() as value",[]),
 rotationCommit:(g,o,n,c)=>scalar("select hag_private.gmail_rotation_commit($1::bigint,$2,$3,$4) as value",[g,o,n,c]),
 reviewList:()=>scalar("select hag_private.gmail_review_list() as value",[]),
 reviewClose:(j,a,d)=>scalar("select hag_private.gmail_review_close($1::uuid,$2::uuid,$3) as value",[j,a,d])};
}
export function gmailDispatchDb(query){
 const scalar=async(sql,args)=>{const r=await query(sql,args);if(r?.rows?.length!==1)throw Error("Database unavailable");return r.rows[0].value;};
 return {claim:()=>scalar("select hag_private.gmail_claim() as value",[]),
 reserve:(j,k,v)=>scalar("select hag_private.gmail_reserve($1::uuid,$2::uuid,$3,$4) as value",[j.id,j.lease,k,v]),
 allowed:(t,g,m)=>scalar("select hag_private.gmail_dispatch_allowed($1::uuid,$2::bigint,$3,$4,$5) as value",[t,g,m.destination,m.purpose,m.token]),
 finish:(t,o)=>scalar("select hag_private.gmail_finish($1::uuid,$2) as value",[t,o])};
}
// Integration boundary: verifier MUST validate Supabase JWT and current auth session,
// call existing hag_admin_access_state with user's token, and prove recent step-up.
// No client-supplied identity or browser-supplied AAL is accepted.
function validateAdmin(a,now){return a?.gate==="authorized"&&a.sessionActive===true&&uuid(a.actor)&&uuid(a.session)&&Number.isFinite(a.stepUpAt)&&a.stepUpAt<=now&&now-a.stepUpAt<=300000;}
async function reviewBody(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type")||"")||req.headers.has("content-encoding")||!req.body)throw Error("Invalid review");
 const reader=req.body.getReader();let n=0,timer;const chunks=[];
 try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Body timeout")),2000);});
 while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;n+=value.byteLength;if(n>1024)throw Error("Body too large");chunks.push(value);}
 const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
 if(!value||Object.keys(value).length!==2||!uuid(value.job)||!["closed-unverified-no-resend","provider-acceptance-observed-no-resend"].includes(value.disposition))throw Error("Invalid review");
 return value;
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
function reply(status,body){return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});}
export function createGmailBackend({mode,control,dispatch,vault,verifyAdmin,fixtureRequest,clientId,clientSecret,outboxKeys,nextVault=null,expectedGeneration=null,protocol=null,now=Date.now}){
 if(mode!=="release-candidate"||typeof fixtureRequest!=="function"||typeof verifyAdmin!=="function"||typeof clientId!=="string"||! /^[a-zA-Z0-9._-]+[.]apps[.]googleusercontent[.]com$/.test(clientId)||!secret(clientSecret)||!control||!dispatch||!vault||typeof outboxKeys!=="function"||!protocol)throw Error("Invalid release configuration");
 const call=async(url,form,access)=>{const headers=access?{"Authorization":"Bearer "+access,"Content-Type":"application/json"}:{"Content-Type":"application/x-www-form-urlencoded"};const body=access?JSON.stringify(form):new URLSearchParams(form).toString();return (protocol?.request||fixtureRequest)({url,method:"POST",headers,body,redirect:"error",timeoutMs:5000});};
 const vaultFor=version=>version===vault.version?vault:nextVault?.version===version?nextVault:null;
 const revoke=async token=>{try{return (await call(REVOKE,{token})).status===200;}catch{return false;}};
 const exchange=async form=>call(TOKEN,{client_id:clientId,client_secret:clientSecret,...form});
 const tokenValid=r=>r?.status===200&&scopeIsSendOnly(r.body?.scope)&&r.body?.token_type==="Bearer"&&secret(r.body?.access_token)&&Number.isInteger(r.body?.expires_in)&&r.body.expires_in>0&&r.body.expires_in<=3600;
 async function handle(req){
  try{
   const u=new URL(req.url);
   if(u.origin!==ORIGIN||!["/oauth/gmail/start","/oauth/gmail/callback","/oauth/gmail/status","/oauth/gmail/disable","/oauth/gmail/disconnect","/oauth/gmail/review","/oauth/gmail/review-close","/oauth/gmail/rotate"].includes(u.pathname))return reply(404,{ok:false});
   // A real callback must bridge an authenticated session safely. This fixture
   // requires a trusted verifier on every request, including the GET callback.
   if(u.pathname!=="/oauth/gmail/callback"&&(req.method!=="POST"||req.headers.get("origin")!==ORIGIN||u.search))return reply(403,{ok:false});
   if(u.pathname==="/oauth/gmail/callback"&&req.method!=="GET")return reply(405,{ok:false});
   const a=await verifyAdmin(req);if(!validateAdmin(a,now()))return reply(403,{ok:false});
   if(u.pathname.endsWith("/status")){const s=await control.status();return reply(200,{connected:s.connected===true,enabled:s.enabled===true});}
   if(u.pathname.endsWith("/review")){
    const rows=await control.reviewList();
    if(!Array.isArray(rows)||rows.length>50)return reply(503,{ok:false});
    return reply(200,{holds:rows.map(v=>({job_id:v.job_id,created_at:v.created_at,outcome:"ambiguous-hold-no-resend",started:v.started===true}))});
   }
   if(u.pathname.endsWith("/review-close")){
    let v;try{v=await reviewBody(req);}catch{return reply(400,{ok:false});}
    const fresh=await verifyAdmin(req);if(!validateAdmin(fresh,now())||fresh.actor!==a.actor||fresh.session!==a.session)return reply(403,{ok:false});
    const ok=await control.reviewClose(v.job,a.actor,v.disposition);return reply(ok?200:409,{ok});
   }
   if(u.pathname.endsWith("/rotate")){
    if(!nextVault||nextVault.version===vault.version)return reply(409,{ok:false});
    const current=await control.rotationRead();
    if(!current||current.key_version!==vault.version)return reply(409,{ok:false});
    const value=vault.open(current.credential,"refresh");
    if(!secret(value?.token))return reply(409,{ok:false});
    const fresh=await verifyAdmin(req);if(!validateAdmin(fresh,now())||fresh.actor!==a.actor||fresh.session!==a.session)return reply(403,{ok:false});
    const ok=await control.rotationCommit(current.generation,vault.version,nextVault.version,nextVault.seal(value,"refresh"));
    return reply(ok?200:409,{ok,enabled:false});
   }
   if(u.pathname.endsWith("/disable")){await control.disable(false);return reply(200,{enabled:false});}
   if(u.pathname.endsWith("/disconnect")){
    const s=await control.disable(true);let revoked=false;
    if(s?.credential&&vaultFor(s.key_version)){try{revoked=await revoke(vaultFor(s.key_version).open(s.credential,"refresh").token);}catch{/* Local disable is durable; provider revocation may need manual action. */}}
    return reply(200,{connected:false,enabled:false,providerRevoked:revoked});
   }
   if(u.pathname.endsWith("/start")){
    const s=await control.status();if(s.connected)return reply(409,{ok:false});
    const p=createAuthorizationPlan({clientId,redirectUri:protocol.callback});const d=digest(p.parameters.state);
    const encrypted=vault.seal(p.verifier,"state:"+d+":"+a.actor+":"+a.session);
    const g=expectedGeneration===null?await control.begin(d,a.actor,a.session,encrypted):await control.beginAtGeneration(d,a.actor,a.session,encrypted,expectedGeneration);
    if(g===null)return reply(409,{ok:false});
    return reply(200,{parameters:p.parameters}); // no actual redirect
   }
   const state=u.searchParams.get("state"),code=u.searchParams.get("code");
   if(u.searchParams.getAll("state").length!==1||typeof state!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(state)||u.searchParams.getAll("code").length!==1||!secret(code)||u.searchParams.has("error"))return reply(400,{ok:false});
   const d=digest(state),s=await control.take(d,a.actor,a.session);
   if(!s)return reply(400,{ok:false});
   const verifier=vault.open(s.verifier,"state:"+d+":"+a.actor+":"+a.session);
   const t=await exchange({grant_type:"authorization_code",code,redirect_uri:protocol?.callback||CALLBACK,code_verifier:verifier});
   if(!tokenValid(t)||!secret(t.body?.refresh_token)){if(secret(t.body?.refresh_token))await revoke(t.body.refresh_token);else if(secret(t.body?.access_token))await revoke(t.body.access_token);return reply(400,{ok:false});}
   // Sending identity cannot be proven with gmail.send alone. Connection is
   // stored disabled; a separately authorized alias acceptance test is required.
   try{
    const fresh=await verifyAdmin(req);
    if(!validateAdmin(fresh,now())||fresh.actor!==a.actor||fresh.session!==a.session){await revoke(t.body.refresh_token);return reply(403,{ok:false});}
    if(!await control.store(s.generation,vault.seal({token:t.body.refresh_token},"refresh"),vault.version)){await revoke(t.body.refresh_token);return reply(409,{ok:false});}
    return reply(200,{connected:true,enabled:false});
   }catch{await revoke(t.body.refresh_token);return reply(503,{ok:false});}
  }catch{return reply(503,{ok:false});}
 }
 async function pump(){
  let reservation;
  try{
   const job=await dispatch.claim();if(!job)return "empty";
   const key=outboxKeys(job.key_version);if(!key)return "key-unavailable";
   reservation=await dispatch.reserve(job,key,job.key_version);if(!reservation)return "not-reserved";
   let outcome="ambiguous-hold-no-resend";
   try{
    const credentialVault=vaultFor(reservation.key_version);if(!credentialVault)throw Error("Unavailable credential key");
    const refresh=credentialVault.open(reservation.credential,"refresh").token;
    if(!secret(refresh))throw Error("Invalid stored token");
    const t=await exchange({grant_type:"refresh_token",refresh_token:refresh});
    if(!tokenValid(t)){outcome="authorization-required";}
    else if(t.body.refresh_token!==undefined){outcome="authorization-required";} // unexpected rotation: stop, no silent replacement
    else {
     const message=protocol.render({id:reservation.id,...reservation.message});
     if(!await dispatch.allowed(reservation.ticket,reservation.generation,reservation.message))outcome="permanent-or-configuration-review";
     else {const response=await call(SEND,message,t.body.access_token);outcome=classifyGmailOutcome(response.status);if(outcome==="accepted-not-delivered"&&!secret(response.body?.id))outcome="ambiguous-hold-no-resend";}
    }
   }catch{/* Reservation remains non-retryable, including transport timeout. */}
   await dispatch.finish(reservation.ticket,outcome);return outcome;
  }catch{return reservation?"ambiguous-hold-no-resend":"unavailable";}
 }
 return Object.freeze({handle,pump});
}
