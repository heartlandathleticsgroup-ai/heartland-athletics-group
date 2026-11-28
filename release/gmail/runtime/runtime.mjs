// Unpublished runtime assembly. No network or DB I/O occurs on import.
import {Buffer} from "node:buffer";
import {createHash,timingSafeEqual} from "node:crypto";
import {createReleaseExecutor} from "./driver.mjs";
import {createCredentialVault,createGmailBackend,gmailControlDb,gmailDispatchDb} from "./backend.mjs";
import {createCallbackBridge,createFlowDb} from "./callback.mjs";
import {createStaticLaunchBridge,createLaunchDb} from "./launch.mjs";
import {createProductionProtocol,createUserProofRpc,CONTROL_BASE} from "./protocol.mjs";
import {createHostedRouteAdapter} from "./routes.mjs";
import {createGatewayCore,createIngressGuardCore} from "./gateway-core.mjs";
import {postgresAdapter} from "./postgres-adapter.mjs";
import {validEmail} from "./policy.mjs";
const mode="release-candidate",API="https://unrqbfngcgvqnytxbtgj.supabase.co",ADMIN="https://heartlandathleticsgroup.com";
const PRIVATE_WORKER=API+"/functions/v1/hag-gmail-worker";
const PREF=API+"/functions/v1/hag-subscriptions";
const goodKey=k=>typeof k==="string"&&/^[a-f0-9]{64}$/.test(k)&&new Set(k).size>=8;
function response(status,value){return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});}
function digest(v){return createHash("sha256").update(v).digest();}
function keyring(current,next){
 const m=new Map();for(const item of [current,next])if(item){if(!goodKey(item.key)||typeof item.version!=="string"||! /^[a-zA-Z0-9_-]{1,32}$/.test(item.version)||m.has(item.version))throw Error("Invalid key configuration");m.set(item.version,item.key);}
 return v=>m.get(v)||null;
}
// pg_net sends an empty JSON body by default. Bound it strictly; never parse
// arbitrary job instructions from a scheduler request.
async function emptyWorkerBody(req){
 if(!req.body)return true;
 if(req.headers.has("content-encoding")||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type")||""))return false;
 const reader=req.body.getReader();let timer;const chunks=[];let n=0;
 try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Timeout")),1000);});while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;n+=value.byteLength;if(n>32)return false;chunks.push(value);}return /^\s*\{\s*\}\s*$/.test(Buffer.concat(chunks).toString("utf8"));}catch{return false;}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
function flags(cfg){
 if(!cfg||cfg.runtime!=="approved-runtime")return {configured:false,oauth:false,send:false,preferences:false};
 // Separate release controls. A disabled deployment does not even create
 // database connections or load Google secrets. Sender enablement also requires DB approval.
 return {configured:true,oauth:cfg.oauth===true,send:cfg.oauth===true&&cfg.send===true,preferences:cfg.preferences===true};
}
export function createReleaseRuntime({config,postgres,fetcher,now=Date.now}){
 const f=flags(config);
 if(!f.configured)return {control:async()=>response(503,{ok:false,disabled:true}),worker:async()=>response(503,{ok:false,disabled:true}),preferences:async()=>response(503,{ok:false,disabled:true}),close:async()=>{}};
 if(typeof fetcher!=="function"||!goodKey(config.vault?.key)||!goodKey(config.outbox?.key)||config.vault.key===config.outbox.key||!goodKey(config.workerKey)||[config.vault.key,config.outbox.key].includes(config.workerKey))throw Error("Private runtime configuration invalid");
 const network={oauth:f.oauth,send:f.send};
 // Separate executor identities. Driver has no broad service-role credential.
 const controlExec=createReleaseExecutor({postgres,url:config.controlDb,ca:config.ca,kind:"control"});
 const dispatchExec=createReleaseExecutor({postgres,url:config.dispatchDb,ca:config.ca,kind:"dispatch"});
 const gatewayExec=createReleaseExecutor({postgres,url:config.gatewayDb,ca:config.ca,kind:"gateway"});
 const keyValues=[config.vault.key,config.outbox.key,config.workerKey,config.priorOutbox?.key,config.nextVault?.key].filter(Boolean);if(new Set(keyValues).size!==keyValues.length)throw Error("Keys must be independent");
 const keys=keyring(config.outbox,config.priorOutbox),vault=createCredentialVault(config.vault),nextVault=config.nextVault?createCredentialVault(config.nextVault):null;
 if(nextVault&&(!goodKey(config.nextVault.key)||config.nextVault.key===config.vault.key||config.nextVault.key===config.outbox.key||config.nextVault.key===config.workerKey||nextVault.version===vault.version))throw Error("Invalid key rotation");
 const controlDb=gmailControlDb(controlExec.execute),dispatch=gmailDispatchDb(dispatchExec.execute);
 // In disabled OAuth mode use a private inert client configuration; no call
 // to Google is permitted. Real values must be provisioned privately later.
 const clientId=config.clientId||"disabled.apps.googleusercontent.com",clientSecret=config.clientSecret||"disabled-client-not-authorized";
 if(f.oauth&&(!config.clientId||!config.clientSecret||!config.postalFooter))throw Error("Google configuration missing");
 const protocol=createProductionProtocol({mode,fetchFixture:fetcher,clientId,clientSecret,postalFooter:config.postalFooter||"Disabled delivery - no postal configuration",network});
 const proofRpc=createUserProofRpc({mode,fetchFixture:fetcher,publishableKey:config.publishableKey});
 const proof=async bearer=>{const r=await proofRpc({name:"hag_gmail_admin_proof",args:{},bearer});return r?.error?null:r?.data??null;};
 const common={mode,control:controlDb,dispatch,vault,nextVault,protocol,fixtureRequest:protocol.request,clientId,clientSecret,outboxKeys:keys,now};
 const backend=(req,bearer,expectedGeneration=null)=>createGmailBackend({...common,expectedGeneration,verifyAdmin:()=>proof(bearer)}).handle(req);
 const callback=createCallbackBridge({mode,backend,flows:createFlowDb(controlExec.execute),vault,userProof:proof,now});
 const launch=createStaticLaunchBridge({mode,callback,launches:createLaunchDb(controlExec.execute),vault,userProof:proof,now});
 const controlRoute=createHostedRouteAdapter({mode,handle:launch,clientId,oauthEnabled:f.oauth});
 let controlBusy=0,workerBusy=false;
 const control=async req=>{if(controlBusy>=8)return response(429,{ok:false});controlBusy++;try{return await controlRoute(req);}finally{controlBusy--;}};
 const pump=createGmailBackend({...common,verifyAdmin:async()=>null}).pump;
 const worker=async req=>{
  const u=new URL(req.url);
  if(u.href!==PRIVATE_WORKER||req.method!=="POST"||req.headers.has("origin"))return response(403,{ok:false});
  const token=req.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!token||!timingSafeEqual(digest(token),digest(config.workerKey)))return response(403,{ok:false});
  if(!await emptyWorkerBody(req))return response(400,{ok:false});
  if(!f.send)return response(503,{ok:false,disabled:true});
  if(workerBusy)return response(429,{ok:false});
  workerBusy=true;
  try{const outcome=await pump();return response(200,{outcome});}catch{return response(503,{ok:false});}finally{workerBusy=false;}
 };
 // No trust in forwarded IPs. Use a conservative shared bucket until
 // hosted ingress verification passes; separate opt-out lane in database.
 // Availability/DoS acceptance remains a release gate before public signup.
 const canonical=s=>s==="edge-shared"?"edge-shared":null;
 const db=postgresAdapter(gatewayExec.execute);
 const enqueueEmail=async(id,action,item)=>{
  if(action!=="access"||item.channel!=="email"||!validEmail(item.destination)||!["manage","unsubscribe"].includes(item.purpose))throw Error("Access only");
  await gatewayExec.execute("select hag_private.subscription_enqueue_email($1::uuid,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11) as value",[id,action,null,null,item.destination,null,null,null,item.purpose,config.outbox.key,config.outbox.version]);
 };
 const optInEmail=async(id,item)=>{if(!f.send||item.channel!=="email"||!validEmail(item.destination))throw Error("Signup unavailable");return gatewayExec.execute("select hag_private.subscription_email_opt_in_welcome($1::uuid,$2,$3,$4,$5::text[],$6,$7,$8,$9) as value",[id,item.name,item.adult,item.destination,item.topics,item.consentText!==undefined,item.consentVersion,config.outbox.key,config.outbox.version]);};
 const sportMode=config.sportPreferences===true;
 const sportScalar=async(q,args)=>{const r=await gatewayExec.execute(q,args);if(r?.rows?.length!==1)throw Error("Sport preference unavailable");return r.rows[0].value;};
 const sportDb={
  sportCatalog:()=>sportScalar("select hag_private.sport_public_catalog() as value",[]),
  sportSignup:(id,name,v)=>sportScalar("select hag_private.sport_email_signup($1::uuid,$2,$3,$4,$5::text[],$6::text[],$7,$8,$9,$10) as value",[id,name,true,v.destination,v.sports,v.updates,true,"draft-sports-v2",config.outbox.key,config.outbox.version]),
  sportManage:t=>sportScalar("select hag_private.sport_manage($1) as value",[t]),
  sportEdit:x=>sportScalar("select hag_private.sport_edit($1,$2::text[],$3::text[],$4,$5,$6) as value",[x.token,x.sports,x.updates,x.adult,x.consent,x.version])
 };
 const gateway=createGatewayCore({sportMode,signupReady:async()=>f.send&&(await controlDb.status())?.enabled===true,db:{...db,...sportDb,optInEmail,issueSms:async()=>{throw Error("SMS provider disabled");},enqueueEmail},delivery:{mode:"email-only",accept:async()=>{throw Error("SMS provider disabled");}},source:()=> "edge-shared",ingress:createIngressGuardCore(canonical),canonicalSource:canonical,atomicEmail:true});
 const preferences=async req=>{
  if(!f.preferences)return response(503,{ok:false,disabled:true});
  try{
   const u=new URL(req.url);
   if(u.origin!==API||![PREF,PREF+"/unsubscribe"].includes(u.origin+u.pathname)||u.search||req.headers.get("origin")!==ADMIN)return response(403,{ok:false});
   const h=new Headers();for(const n of ["origin","content-type","content-length","content-encoding","access-control-request-method","access-control-request-headers"])if(req.headers.has(n))h.set(n,req.headers.get(n));
   const init={method:req.method,headers:h};if(req.method==="POST"&&req.body){init.body=req.body;init.duplex="half";}
   return await gateway(new Request(ADMIN+(u.pathname.endsWith("/unsubscribe")?"/subscriptions/unsubscribe":"/subscriptions"),init));
  }catch{return response(503,{ok:false});}
 };
 return {control,worker,preferences,close:async()=>{await Promise.allSettled([controlExec.close(),dispatchExec.close(),gatewayExec.close()]);}};
}
