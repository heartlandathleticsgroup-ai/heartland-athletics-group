// UNPUBLISHED provider adapter. No default transport or live-mode constructor.
import {GMAIL_SCOPE,GMAIL_FROM,GMAIL_REPLY_TO,scopeIsSendOnly} from "./gmail-preparation.mjs";
const API="https://unrqbfngcgvqnytxbtgj.supabase.co";
export const CONTROL_BASE=API+"/functions/v1/hag-gmail-control";
export const CALLBACK_URI=CONTROL_BASE+"/oauth/gmail/callback";
const TOKEN="https://oauth2.googleapis.com/token",REVOKE="https://oauth2.googleapis.com/revoke",SEND="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const safeToken=x=>typeof x==="string"&&x.length>=8&&x.length<=8192&&/^[\x21-\x7e]+$/.test(x);
const fixture=x=>safeToken(x)&&x.startsWith("fixture-");
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
 if(mode!=="isolated-acceptance"||typeof fetchFixture!=="function"||fetchFixture===globalThis.fetch)throw Error("Isolated transport required");
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
export function createProductionProtocol({mode,fetchFixture,clientId,clientSecret,postalFooter}){
 if(mode!=="isolated-acceptance"||clientId!=="fixture.apps.googleusercontent.com"||!fixture(clientSecret)||typeof postalFooter!=="string"||!postalFooter.startsWith("Fictional ")||postalFooter.length>300||/[\x00-\x1f\x7f]/.test(postalFooter))throw Error("Fixture configuration only");
 const http=createBoundedHttp({mode,fetchFixture});
 const form=(url,p)=>http(url,{headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(p).toString()});
 const request=async({url,method,headers,body})=>{
  if(method!=="POST"||typeof body!=="string"||body.length>65536)throw Error("Invalid provider request");
  if(url===TOKEN){
   const p=new URLSearchParams(body),keys=[...p.keys()],grant=p.get("grant_type"),refresh=grant==="refresh_token";
   const allowed=refresh?["client_id","client_secret","grant_type","refresh_token"]:["client_id","client_secret","grant_type","code","redirect_uri","code_verifier"];
   if(keys.length!==allowed.length||new Set(keys).size!==keys.length||keys.some(k=>!allowed.includes(k))||p.get("client_id")!==clientId||p.get("client_secret")!==clientSecret)throw Error("Invalid provider grant");
   if(refresh?!fixture(p.get("refresh_token")):grant!=="authorization_code"||!fixture(p.get("code"))||p.get("redirect_uri")!==CALLBACK_URI||!/^[A-Za-z0-9_-]{43}$/.test(p.get("code_verifier")||""))throw Error("Invalid provider grant");
   const response=await form(TOKEN,p),g=parseGrant(response,{refresh,previousScope:GMAIL_SCOPE});
   if(!g)return response.status===200?{status:400,body:response.body}:response;
   if(!fixture(g.access_token)||(!refresh&&!fixture(g.refresh_token)))throw Error("Fixture token required");
   return {status:200,body:g};
  }
  if(url===REVOKE){const p=new URLSearchParams(body);if([...p.keys()].length!==1||!fixture(p.get("token")))throw Error("Invalid revocation");return form(REVOKE,p);}
  if(url===SEND){
   const h=new Headers(headers),access=h.get("authorization")?.match(/^Bearer (.+)$/)?.[1];if(!fixture(access))throw Error("Invalid send grant");
   const p=JSON.parse(body),raw=Buffer.from(p.raw||"","base64url").toString("utf8"),head=raw.split("\r\n\r\n",1)[0].split("\r\n");
   if(Object.keys(p).length!==1||head.length!==7||head[0]!=="From: Heartland Athletics Group <"+GMAIL_FROM+">"||head[1]!=="Reply-To: "+GMAIL_REPLY_TO||!/^To: [a-z0-9._+%-]+@[a-z0-9.-]+\.invalid$/.test(head[2])||!/^Subject: (Manage your H\.A\.G\. email preferences|Unsubscribe from H\.A\.G\. marketing email)$/.test(head[3])||!/^Message-ID: <[a-f0-9-]{36}@heartlandathleticsgroup\.com>$/.test(head[4])||head[5]!=="MIME-Version: 1.0"||head[6]!=="Content-Type: text/plain; charset=UTF-8; format=flowed"||!raw.includes("\r\n"+postalFooter+"\r\n"))throw Error("Invalid isolated message");
   const r=await http(SEND,{headers:{"Authorization":"Bearer "+access,"Content-Type":"application/json"},body:JSON.stringify(p)});
   // Gmail message IDs are opaque, not fixture-prefixed in the real protocol.
   if(r.status>=200&&r.status<300&&typeof r.body?.id==="string"&&/^[a-zA-Z0-9_-]{1,256}$/.test(r.body.id))return {status:r.status,body:{id:"fixture-"+r.body.id}};
   return r.status>=200&&r.status<300?{status:502,body:null}:r;
  }
  throw Error("Endpoint denied");
 };
 const render=({id,destination,purpose,token})=>{
  if(!idOk(id)||typeof destination!=="string"||destination.length>254||!/^[a-z0-9._+%-]+@[a-z0-9.-]+\.invalid$/.test(destination)||!["manage","unsubscribe"].includes(purpose)||typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))throw Error("Isolated access email only");
  // No marketing or confirmation message. The live preference endpoint is
  // not yet deployed, so acceptance uses a reserved-domain link.
  const subject=purpose==="manage"?"Manage your H.A.G. email preferences":"Unsubscribe from H.A.G. marketing email";
  const raw=["From: Heartland Athletics Group <"+GMAIL_FROM+">","Reply-To: "+GMAIL_REPLY_TO,"To: "+destination,"Subject: "+subject,"Message-ID: <"+id+"@heartlandathleticsgroup.com>","MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8; format=flowed","",subject+". If you did not request this link, ignore this email.","https://preview.invalid/preferences#"+purpose+":"+token,"",postalFooter,"Questions: "+GMAIL_REPLY_TO,""].join("\r\n");
  return {raw:Buffer.from(raw,"utf8").toString("base64url")};
 };
 return Object.freeze({request,render,callback:CALLBACK_URI});
}
export function createUserProofRpc({mode,fetchFixture,publishableKey}){
 if(mode!=="isolated-acceptance"||publishableKey!=="fixture-publishable-key")throw Error("Fixture configuration only");
 const http=createBoundedHttp({mode,fetchFixture});
 return async ({name,args,bearer})=>{
  if(name!=="hag_gmail_admin_proof"||Object.keys(args||{}).length||!fixture(bearer))return {error:true};
  try{const r=await http(API+"/rest/v1/rpc/hag_gmail_admin_proof",{headers:{apikey:publishableKey,Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:"{}"});return r.status===200?{data:r.body}:{error:true};}catch{return {error:true};}
 };
}
