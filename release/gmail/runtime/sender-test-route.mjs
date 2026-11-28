import {createSenderTest} from "./sender-test.mjs";
import {createCredentialVault} from "./backend.mjs";
import {createReleaseExecutor,checkedDbOptions} from "./driver.mjs";
import {createUserProofRpc} from "./protocol.mjs";
import {jwt} from "./policy.mjs";
export const ORIGIN="https://heartlandathleticsgroup.com";
export const TEST_ID="5597960a-8dde-486c-80fb-80454eda49cd";
const proofURL="https://unrqbfngcgvqnytxbtgj.supabase.co/rest/v1/rpc/hag_gmail_admin_proof";
const tokenURL="https://oauth2.googleapis.com/token";
const sendURL="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const categories=new Set(["not-authorized","accepted-not-delivered","ambiguous-hold-no-resend","authorization-required","provider-rejected"]);
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Vary":"Origin"};
const answer=(status,body=null,cors=false)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{...headers,...(cors?{"Access-Control-Allow-Origin":ORIGIN}:{}),...(status===204&&cors?{"Access-Control-Allow-Methods":"POST","Access-Control-Allow-Headers":"authorization"}:{}),...(body===null?{}:{"Content-Type":"application/json"})}});
// Hosted gateways may supply an empty ReadableStream for a zero-byte POST.
// Reject all nonempty payloads, even if a caller lies about Content-Length.
async function emptyBody(req){
 const length=req.headers.get("content-length");
 if(req.headers.has("content-encoding")||(length!==null&&length!=="0"))return false;
 if(!req.body)return true;
 const reader=req.body.getReader();let timer;
 try{
  const read=async()=>{for(;;){const {done,value}=await reader.read();if(done)return true;if(value?.byteLength!==0)return false;}};
  return await Promise.race([read(),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
 }catch{return false;}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function createSenderTestRoute({config,postgres,fetcher,now=Date.now}){
 if(!config||config.runtime!=="approved-runtime"||config.oauth!==true||config.send!==false||config.preferences!==false||config.sportPreferences!==false||typeof fetcher!=="function")throw Error("Delivery must remain disabled");
 if(!/^[a-f0-9]{64}$/.test(config.vault?.key||"")||new Set(config.vault.key).size<8||!/^[-a-zA-Z0-9._]+\.apps\.googleusercontent\.com$/.test(config.clientId||"")||typeof config.postalFooter!=="string"||config.postalFooter.trim().length<15||config.postalFooter.length>300||/[\x00-\x1f\x7f]/.test(config.postalFooter))throw Error("Invalid private configuration");
 checkedDbOptions(config.dispatchDb,config.ca,"dispatch");
 const vault=createCredentialVault(config.vault);
 const safeFetch=(url,opts)=>{if(![proofURL,tokenURL,sendURL].includes(url))throw Error("Endpoint denied");return fetcher(url,opts);};
 const proofRpc=createUserProofRpc({mode:"release-candidate",fetchFixture:safeFetch,publishableKey:config.publishableKey});
 const proof=async bearer=>{const v=await proofRpc({name:"hag_gmail_admin_proof",args:{},bearer});return v?.error?null:v?.data??null;};
 let busy=false;
 return async(req)=>{
  const u=new URL(req.url),path=u.pathname,origin=req.headers.get("origin")===ORIGIN;
  if(u.search||!["/hag-gmail-sender-test/run","/functions/v1/hag-gmail-sender-test/run","/hag-gmail-sender-test/readiness","/functions/v1/hag-gmail-sender-test/readiness"].includes(path))return answer(404);
  if(path.endsWith("/readiness"))return req.method==="GET"?answer(204):answer(405);
  if(!origin)return answer(403);
  if(req.method==="OPTIONS")return req.headers.get("access-control-request-method")==="POST"&&(req.headers.get("access-control-request-headers")||"").trim().toLowerCase()==="authorization"?answer(204,null,true):answer(403,null,true);
  const bearer=req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if(req.method!=="POST"||!jwt(bearer)||!await emptyBody(req))return answer(403,{outcome:"not-authorized"},true);
  if(busy)return answer(409,{outcome:"not-authorized"},true);
  busy=true;let exec;
  try{
   // No database connection or provider request occurs until a fresh admin proof passes.
   const a=await proof(bearer);if(a?.gate!=="authorized"||a.sessionActive!==true||!Number.isFinite(a.stepUpAt)||a.stepUpAt>now()||now()-a.stepUpAt>300000)return answer(403,{outcome:"not-authorized"},true);
   exec=createReleaseExecutor({postgres,url:config.dispatchDb,ca:config.ca,kind:"dispatch"});
   const scalar=async(q,args)=>{const r=await exec.execute(q,args);if(r?.rows?.length!==1)throw Error("Private operation unavailable");return r.rows[0].value;};
   const run=createSenderTest({mode:"single-sender-test",claim:id=>scalar("select hag_private.gmail_sender_test_claim($1::uuid) as value",[id]),start:(id,g)=>scalar("select hag_private.gmail_sender_test_start($1::uuid,$2::bigint) as value",[id,g]),finish:(id,o)=>scalar("select hag_private.gmail_sender_test_finish($1::uuid,$2) as value",[id,o]),verifyAdmin:proof,vault,fetchFixture:safeFetch,clientId:config.clientId,clientSecret:config.clientSecret,postalFooter:config.postalFooter,now});
   const outcome=await run({testId:TEST_ID,bearer});return answer(outcome==="not-authorized"?409:200,{outcome:categories.has(outcome)?outcome:"ambiguous-hold-no-resend"},true);
  }catch{return answer(503,{outcome:"ambiguous-hold-no-resend"},true);}
  finally{if(exec)try{await exec.close();}catch{}busy=false;}
 };
}
