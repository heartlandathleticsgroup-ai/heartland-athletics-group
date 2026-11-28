// Connection-only release. No dispatch executor, outbox, subscriber gateway,
// scheduler or send transport is created. All delivery routes are denied.
import {createReleaseExecutor,checkedDbOptions} from "./driver.mjs";
import {createCredentialVault,createGmailBackend,gmailControlDb} from "./backend.mjs";
import {createCallbackBridge,createFlowDb} from "./callback.mjs";
import {createStaticLaunchBridge,createLaunchDb} from "./launch.mjs";
import {createProductionProtocol,createUserProofRpc,CONTROL_BASE} from "./protocol.mjs";
import {createHostedRouteAdapter} from "./routes.mjs";
const allowedRoutes=new Set(["status","prepare","launch","callback","result","disconnect","disable"]);
const mode="release-candidate";
const validKey=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)&&new Set(x).size>=8;
const denied=()=>new Response('{"ok":false}',{status:503,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});
export function createConnectionOnly({config,postgres,fetcher,now=Date.now,diagnostic=()=>{}}){
 if(!config||config.send!==false||config.preferences!==false||config.sportPreferences!==false)throw Error("Delivery must remain disabled");
 if(!validKey(config.vault?.key)||!config.clientId||!config.clientSecret||!config.postalFooter)throw Error("Private configuration invalid");
 checkedDbOptions(config.controlDb,config.ca,"control");
 const vault=createCredentialVault(config.vault);
 // Explicit network allowlist; even an erroneous backend pump cannot send.
 const safeFetch=(url,options)=>{
  if(!["https://oauth2.googleapis.com/token","https://oauth2.googleapis.com/revoke","https://unrqbfngcgvqnytxbtgj.supabase.co/rest/v1/rpc/hag_gmail_admin_proof"].includes(url))throw Error("Connection-only endpoint denied");
  return fetcher(url,options);
 };
 const active=config.runtime==="approved-runtime"&&config.oauth===true;
 const protocol=createProductionProtocol({mode,fetchFixture:safeFetch,clientId:config.clientId,clientSecret:config.clientSecret,postalFooter:config.postalFooter,network:{oauth:active,send:false},diagnostic});
 const proofRpc=createUserProofRpc({mode,fetchFixture:safeFetch,publishableKey:config.publishableKey});
 if(!active)return {handle:async()=>denied(),close:async()=>{}};
 const exec=createReleaseExecutor({postgres,url:config.controlDb,ca:config.ca,kind:"control"});
 // Only the specific connection lifecycle functions may be called.
 const permitted=new Set(["gmail_status","gmail_disable","gmail_begin_at_generation","gmail_take","gmail_store","gmail_flow_put","gmail_flow_take","gmail_launch_put","gmail_launch_take"]);
 const query=(q,args)=>{
  if(!permitted.has(q.match(/^select hag_private\.([a-z_]+)\(/)?.[1]))throw Error("Connection-only query denied");
  return exec.execute(q,args);
 };
 const control=gmailControlDb(query);
 const proof=async bearer=>{const r=await proofRpc({name:"hag_gmail_admin_proof",args:{},bearer});return r?.error?null:r?.data??null;};
 const backend=(req,bearer,expectedGeneration=null)=>createGmailBackend({mode,control,dispatch:Object.freeze({}),vault,protocol,fixtureRequest:protocol.request,clientId:config.clientId,clientSecret:config.clientSecret,outboxKeys:()=>null,now,diagnostic,expectedGeneration,verifyAdmin:()=>proof(bearer)}).handle(req);
 const callback=createCallbackBridge({mode,backend,flows:createFlowDb(query),vault,userProof:proof,now,diagnostic});
 const launch=createStaticLaunchBridge({mode,callback,launches:createLaunchDb(query),vault,userProof:proof,now});
 const route=createHostedRouteAdapter({mode,handle:launch,clientId:config.clientId,oauthEnabled:true});
 let busy=0;
 return {handle:async req=>{
  const u=new URL(req.url),prefix=CONTROL_BASE+"/oauth/gmail/";
  if(!u.href.startsWith(prefix)||!allowedRoutes.has(u.pathname.split("/").at(-1))||u.pathname!==new URL(prefix+u.pathname.split("/").at(-1)).pathname||busy>=8)return denied();
  busy++;try{return await route(req);}finally{busy--;}
 },close:()=>exec.close()};
}
