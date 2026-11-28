// Unpublished bridge: same-origin server page; fixture mode only.
// A short-lived opaque HttpOnly cookie binds the callback to an encrypted
// user bearer stored server-side. No refresh token, code or bearer in a URL.
import {randomBytes,createHash} from "node:crypto";
const hash=s=>createHash("sha256").update(s).digest("hex");
const opaque=()=>randomBytes(32).toString("base64url");
const valid=s=>typeof s==="string"&&/^[A-Za-z0-9_-]{43}$/.test(s);
const COOKIE="__Host-hag-gmail-flow";
const ORIGIN="https://preview.invalid";
const cookie=(s,max)=>COOKIE+"="+s+"; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age="+max;
const denied=()=>new Response(JSON.stringify({ok:false}),{status:403,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
const resultRedirect=ok=>new Response(null,{status:303,headers:{"Location":ORIGIN+"/oauth/gmail/result?status="+(ok?"complete":"failed"),"Set-Cookie":cookie("",0),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
function readCookie(req){const values=(req.headers.get("cookie")||"").split(";").map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+"="));return values.length===1?values[0].slice(COOKIE.length+1):null;}
export function createFlowDb(query){
 const scalar=async(q,a)=>{const r=await query(q,a);if(r?.rows?.length!==1)throw Error("Flow unavailable");return r.rows[0].value;};
 return {put:(d,s,c)=>scalar("select hag_private.gmail_flow_put($1,$2,$3) as value",[d,s,c]),take:(d,s)=>scalar("select hag_private.gmail_flow_take($1,$2) as value",[d,s])};
}
export function createCallbackBridge({mode,backend,flows,vault,userProof,now=Date.now}){
 if(mode!=="isolated-test"||typeof backend!=="function"||!flows||!vault||typeof userProof!=="function")throw Error("Isolated bridge only");
 // Only this request-scoped closure provides the bearer to the trusted verifier.
 // No inbound identity/assurance header is forwarded as proof.
 return async (req,expectedGeneration=null)=>{
  try{
   const u=new URL(req.url);
   if(u.origin!==ORIGIN)return denied();
   if(u.pathname==="/oauth/gmail/result"){
    if(req.method!=="GET")return denied();
    // Do not reflect URL fields or disclose connection state without authentication.
    return new Response("Authorization flow ended. Return to the administrative portal and check connection status.",{status:200,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff"}});
   }
   if(u.pathname==="/oauth/gmail/start"){
    if(req.method!=="POST"||req.headers.get("origin")!==ORIGIN||u.search)return denied();
    const bearer=req.headers.get("authorization")?.match(/^Bearer (fixture-[A-Za-z0-9_-]{8,200})$/)?.[1];
    if(!bearer)return denied();
    const proof=await userProof(bearer);if(!proof)return denied();
    const result=await backend(req,bearer,expectedGeneration);if(result.status!==200)return result;
    const data=await result.json(),state=data?.parameters?.state;if(!valid(state))return denied();
    const id=opaque(),d=hash(id),s=hash(state);
    const ciphertext=vault.seal({bearer,actor:proof.actor,session:proof.session,expires:now()+300000},"flow:"+d+":"+s);
    if(!await flows.put(d,s,ciphertext))return denied();
    const headers=new Headers(result.headers);headers.set("Set-Cookie",cookie(id,300));headers.set("Cache-Control","no-store");
    // Return only inert OAuth parameters in this fixture. Never navigate to Google.
    return new Response(JSON.stringify(data),{status:200,headers});
   }
   if(u.pathname==="/oauth/gmail/callback"){
    if(req.method!=="GET")return denied();
    if(u.searchParams.getAll("state").length!==1)return resultRedirect(false);
    const id=readCookie(req),state=u.searchParams.get("state");
    if(!valid(id)||!valid(state))return resultRedirect(false);
    const d=hash(id),s=hash(state),enc=await flows.take(d,s);
    if(!enc)return resultRedirect(false);
    const f=vault.open(enc,"flow:"+d+":"+s);
    if(!Number.isFinite(f.expires)||f.expires<=now())return resultRedirect(false);
    const proof=await userProof(f.bearer);
    if(!proof||proof.actor!==f.actor||proof.session!==f.session)return resultRedirect(false);
    const result=await backend(req,f.bearer);
    // Discard callback output; strip code/state from browser URL even on failure.
    return resultRedirect(result.status===200);
   }
   // Other control routes require a fresh user bearer, never the flow cookie.
   if(req.method!=="POST"||req.headers.get("origin")!==ORIGIN||u.search)return denied();
   const bearer=req.headers.get("authorization")?.match(/^Bearer (fixture-[A-Za-z0-9_-]{8,200})$/)?.[1];if(!bearer)return denied();
   return backend(req,bearer);
  }catch{try{const u=new URL(req.url);if(u.origin===ORIGIN&&u.pathname==="/oauth/gmail/callback"&&req.method==="GET")return resultRedirect(false);}catch{}return denied();}
 };
}
