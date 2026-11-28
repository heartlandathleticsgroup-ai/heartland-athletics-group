// E.9 release candidate, not deployed. Real network gated by private configuration.
// UNPUBLISHED provider adapter. No default transport or live-mode constructor.
import {Buffer} from "node:buffer";
import {GMAIL_SCOPE,GMAIL_FROM,GMAIL_REPLY_TO,scopeIsSendOnly,safeToken,validEmail,jwt} from "./policy.mjs";
const API="https://unrqbfngcgvqnytxbtgj.supabase.co";
export const CONTROL_BASE=API+"/functions/v1/hag-gmail-control";
export const CALLBACK_URI=CONTROL_BASE+"/oauth/gmail/callback";
const TOKEN="https://oauth2.googleapis.com/token",REVOKE="https://oauth2.googleapis.com/revoke",SEND="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const idOk=x=>typeof x==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
async function readJson(r){
 if(!r.body)return null;const reader=r.body.getReader(),parts=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>65536)throw Error("Provider response too large");parts.push(value);}
 if(!total)return null;
 if(!/^application\/json(?:;|$)/i.test(r.headers.get("content-type")||""))throw Error("Unexpected provider content type");
 return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)));
 }finally{void reader.cancel().catch(()=>{});}
}
export function createBoundedHttp({mode,fetchFixture}){
 if(mode!=="release-candidate"||typeof fetchFixture!=="function")throw Error("Isolated transport required");
 return async(url,options)=>{
  if(![TOKEN,REVOKE,SEND,API+"/rest/v1/rpc/hag_gmail_admin_proof"].includes(url))throw Error("Endpoint denied");
  const controller=new AbortController();let timer;
  try{
   const task=(async()=>{const r=await fetchFixture(url,{...options,method:"POST",redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",signal:controller.signal});if(r.redirected||r.status>=300&&r.status<400)throw Error("Redirect denied");return {status:r.status,body:await readJson(r)};})();
   return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("Timeout"));},5000);})]);
  }catch{throw Error("Provider request unavailable");}finally{clearTimeout(timer);}
 };
}
// Exact response parser. Google refresh may omit scope; only inherit an
// already-validated send-only grant, never assume scope on initial exchange.
export function parseGrant(response,{refresh=false,previousScope=null}={}){
 const b=response?.body;
 if(response?.status!==200||!b||!safeToken(b.access_token)||(typeof b.token_type!=="string"||b.token_type.toLowerCase()!=="bearer")||!Number.isInteger(b.expires_in)||b.expires_in<1||b.expires_in>3600)return null;
 const scope=b.scope===undefined&&refresh?previousScope:b.scope;
 if(!scopeIsSendOnly(scope)||(!refresh&&!safeToken(b.refresh_token))||(refresh&&b.refresh_token!==undefined))return null;
 return {access_token:b.access_token,token_type:"Bearer",scope:GMAIL_SCOPE,expires_in:b.expires_in,...(!refresh?{refresh_token:b.refresh_token}:{})};
}
export function createProductionProtocol({mode,fetchFixture,clientId,clientSecret,postalFooter,network={oauth:false,send:false},diagnostic=()=>{}}){
 if(mode!=="release-candidate"||typeof clientId!=="string"||! /^[a-zA-Z0-9._-]+[.]apps[.]googleusercontent[.]com$/.test(clientId)||!safeToken(clientSecret)||typeof postalFooter!=="string"||postalFooter.trim().length<15||postalFooter.length>300||/[\x00-\x1f\x7f]/.test(postalFooter))throw Error("Invalid private configuration");
 const http=createBoundedHttp({mode,fetchFixture});
 const form=(url,p)=>http(url,{headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(p).toString()});
 const request=async({url,method,headers,body})=>{
  if(method!=="POST"||typeof body!=="string"||body.length>65536)throw Error("Invalid provider request");
  if(url===TOKEN){
   if(!network.oauth)throw Error("Google authorization disabled");
   const p=new URLSearchParams(body),keys=[...p.keys()],grant=p.get("grant_type"),refresh=grant==="refresh_token";
   const allowed=refresh?["client_id","client_secret","grant_type","refresh_token"]:["client_id","client_secret","grant_type","code","redirect_uri","code_verifier"];
   if(keys.length!==allowed.length||new Set(keys).size!==keys.length||keys.some(k=>!allowed.includes(k))||p.get("client_id")!==clientId||p.get("client_secret")!==clientSecret)throw Error("Invalid provider grant");
   if(refresh?!safeToken(p.get("refresh_token")):grant!=="authorization_code"||!safeToken(p.get("code"))||p.get("redirect_uri")!==CALLBACK_URI||!/^[A-Za-z0-9_-]{43}$/.test(p.get("code_verifier")||""))throw Error("Invalid provider grant");
   let response;try{response=await form(TOKEN,p);}catch(e){diagnostic("token-transport-unavailable");throw e;}
   const g=parseGrant(response,{refresh,previousScope:GMAIL_SCOPE});
   if(!g){
    const b=response?.body;
    if(response.status!==200){
     const reason=b?.error;
     diagnostic(reason==="invalid_grant"?"token-invalid-grant":reason==="invalid_client"?"token-invalid-client":reason==="unauthorized_client"?"token-unauthorized-client":reason==="access_denied"?"token-access-denied":response.status===429?"token-rate-limited":"token-provider-rejected");
    }else if(!safeToken(b?.access_token))diagnostic("token-access-missing-or-invalid");
    else if(!scopeIsSendOnly(b?.scope===undefined&&refresh?GMAIL_SCOPE:b?.scope))diagnostic("token-scope-not-send-only");
    else if(!refresh&&!safeToken(b?.refresh_token))diagnostic("token-refresh-missing-or-invalid");
    else if(typeof b?.token_type!=="string"||b.token_type.toLowerCase()!=="bearer")diagnostic("token-type-invalid");
    else if(!Number.isInteger(b?.expires_in)||b.expires_in<1||b.expires_in>3600)diagnostic("token-expiry-invalid");
    else diagnostic("token-response-invalid");
    return response.status===200?{status:400,body:response.body}:response;
   }
   diagnostic("token-grant-validated");
   if(!safeToken(g.access_token)||(!refresh&&!safeToken(g.refresh_token)))throw Error("Fixture token required");
   return {status:200,body:g};
  }
  if(url===REVOKE){if(!network.oauth)throw Error("Google authorization disabled");const p=new URLSearchParams(body);if([...p.keys()].length!==1||!safeToken(p.get("token")))throw Error("Invalid revocation");return form(REVOKE,p);}
  if(url===SEND){
   if(!network.oauth||!network.send)throw Error("Email delivery disabled");
   const h=new Headers(headers),access=h.get("authorization")?.match(/^Bearer (.+)$/)?.[1];if(!safeToken(access))throw Error("Invalid send grant");
   const p=JSON.parse(body),raw=Buffer.from(p.raw||"","base64url").toString("utf8"),head=raw.split("\r\n\r\n",1)[0].split("\r\n");
   if(Object.keys(p).length!==1||head.length!==7||head[0]!=="From: Heartland Athletics Group <"+GMAIL_FROM+">"||head[1]!=="Reply-To: "+GMAIL_REPLY_TO||!head[2]?.startsWith("To: ")||!validEmail(head[2].slice(4))||!/^Subject: (Manage your H\.A\.G\. email preferences|Unsubscribe from H\.A\.G\. marketing email|Welcome to Heartland Athletics Group)$/.test(head[3])||!/^Message-ID: <[a-f0-9-]{36}@heartlandathleticsgroup\.com>$/.test(head[4])||head[5]!=="MIME-Version: 1.0"||head[6]!=="Content-Type: text/plain; charset=UTF-8; format=flowed"||!raw.includes("\r\n"+postalFooter+"\r\n"))throw Error("Invalid message");
   const r=await http(SEND,{headers:{"Authorization":"Bearer "+access,"Content-Type":"application/json"},body:JSON.stringify(p)});
   // Gmail message IDs are opaque, not fixture-prefixed in the real protocol.
   if(r.status>=200&&r.status<300&&typeof r.body?.id==="string"&&/^[a-zA-Z0-9_-]{1,256}$/.test(r.body.id))return {status:r.status,body:{id:r.body.id}};
   return r.status>=200&&r.status<300?{status:502,body:null}:r;
  }
  throw Error("Endpoint denied");
 };
 const render=({id,destination,purpose,token})=>{
  if(!idOk(id)||!validEmail(destination)||!["manage","unsubscribe","welcome"].includes(purpose)||typeof token!=="string"||!(purpose==="welcome"?/^[a-f0-9]{64}:[a-f0-9]{64}$/:/^[a-f0-9]{64}$/).test(token))throw Error("Invalid subscription email");
  // A welcome acknowledgment is distinct from verification; two independent capabilities.
  const subject=purpose==="welcome"?"Welcome to Heartland Athletics Group":purpose==="manage"?"Manage your H.A.G. email preferences":"Unsubscribe from H.A.G. marketing email";
   const [manage,unsubscribe]=token.split(":");
   const content=purpose==="welcome"?["Thank you for subscribing to Heartland Athletics Group updates.","Your eligible email sports and update preferences are active. No additional confirmation is required.","Please add no-reply@heartlandathleticsgroup.com to your contacts to help our emails reach your inbox.","","Manage preferences: https://heartlandathleticsgroup.com/preferences/#manage:"+manage,"If your secure management link has expired, request a fresh link at https://heartlandathleticsgroup.com/preferences/.","Unsubscribe: https://heartlandathleticsgroup.com/preferences/#unsubscribe:"+unsubscribe,"If you did not sign up, please unsubscribe or contact us for help."]: [subject+". If you did not request this link, ignore this email.","https://heartlandathleticsgroup.com/preferences/#"+purpose+":"+token];
  const raw=["From: Heartland Athletics Group <"+GMAIL_FROM+">","Reply-To: "+GMAIL_REPLY_TO,"To: "+destination,"Subject: "+subject,"Message-ID: <"+id+"@heartlandathleticsgroup.com>","MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8; format=flowed","",...content,"",postalFooter,"Questions: "+GMAIL_REPLY_TO,""].join("\r\n");
  return {raw:Buffer.from(raw,"utf8").toString("base64url")};
 };
 return Object.freeze({request,render,callback:CALLBACK_URI});
}
export function createUserProofRpc({mode,fetchFixture,publishableKey}){
 if(mode!=="release-candidate"||typeof publishableKey!=="string"||!publishableKey.startsWith("sb_publishable_"))throw Error("Invalid private configuration");
 const http=createBoundedHttp({mode,fetchFixture});
 return async ({name,args,bearer})=>{
  if(name!=="hag_gmail_admin_proof"||Object.keys(args||{}).length||!jwt(bearer))return {error:true};
  try{const r=await http(API+"/rest/v1/rpc/hag_gmail_admin_proof",{headers:{apikey:publishableKey,Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:"{}"});return r.status===200?{data:r.body}:{error:true};}catch{return {error:true};}
 };
}
