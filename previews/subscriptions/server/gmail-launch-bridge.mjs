// Static GitHub Pages -> future runtime top-level handoff. Fixture only.
// The one-use grant is sent in POST body, not query, storage, or cookie.
import {randomBytes,createHash} from "node:crypto";
const ADMIN="https://heartlandathleticsgroup.com",RUNTIME="https://preview.invalid";
const hash=x=>createHash("sha256").update(x).digest("hex");
const valid=x=>typeof x==="string"&&/^[A-Za-z0-9_-]{43}$/.test(x);
const bearerOf=req=>req.headers.get("authorization")?.match(/^Bearer (fixture-[A-Za-z0-9_-]{8,200})$/)?.[1];
const base={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Type":"application/json"};
function json(status,value,cors=false){return new Response(JSON.stringify(value),{status,headers:{...base,...(cors?{"Access-Control-Allow-Origin":ADMIN,"Vary":"Origin"}:{})}});}
async function readGrant(req){
 if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers.get("content-type")||"")||req.headers.has("content-encoding")||!req.body)return null;
 const reader=req.body.getReader();let n=0,timer;const chunks=[];
 try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Body timeout")),2000);});while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;n+=value.byteLength;if(n>128)return null;chunks.push(value);}
 const p=new URLSearchParams(Buffer.concat(chunks).toString("utf8"));const v=p.get("grant");return [...p.keys()].length===1&&valid(v)?v:null;
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function createLaunchDb(query){
 const scalar=async(sql,args)=>{const r=await query(sql,args);if(r?.rows?.length!==1)throw Error("Launch unavailable");return r.rows[0].value;};
 return {put:(d,a,s,c)=>scalar("select hag_private.gmail_launch_put($1,$2::uuid,$3::uuid,$4) as value",[d,a,s,c]),take:d=>scalar("select hag_private.gmail_launch_take($1) as value",[d])};
}
export function createStaticLaunchBridge({mode,callback,launches,vault,userProof,now=Date.now}){
 if(mode!=="isolated-test"||typeof callback!=="function"||!launches||!vault||typeof userProof!=="function")throw Error("Isolated launch only");
 return async req=>{
  try{
   const u=new URL(req.url);if(u.origin!==RUNTIME)return json(403,{ok:false});
   if(!["/oauth/gmail/prepare","/oauth/gmail/launch"].includes(u.pathname))return callback(req);
   const isPrepare=u.pathname.endsWith("/prepare"),origin=req.headers.get("origin"),cors=isPrepare&&origin===ADMIN;
   if(origin!==ADMIN||u.search)return json(403,{ok:false});
   if(isPrepare&&req.method==="OPTIONS"){
    if(req.headers.get("access-control-request-method")!=="POST"||!["authorization","authorization, content-type","content-type, authorization"].includes((req.headers.get("access-control-request-headers")||"").toLowerCase().trim()))return json(403,{ok:false},true);
    return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":ADMIN,"Access-Control-Allow-Methods":"POST","Access-Control-Allow-Headers":"Authorization, Content-Type","Vary":"Origin","Cache-Control":"no-store"}});
   }
   if(req.method!=="POST")return json(405,{ok:false},cors);
   if(isPrepare){
    const bearer=bearerOf(req);if(!bearer)return json(403,{ok:false},true);
    const proof=await userProof(bearer);if(proof?.gate!=="authorized"||proof.sessionActive!==true||!Number.isFinite(proof.stepUpAt)||proof.stepUpAt>now()||now()-proof.stepUpAt>300000)return json(403,{ok:false},true);
    const grant=randomBytes(32).toString("base64url"),d=hash(grant);
    const enc=vault.seal({bearer,actor:proof.actor,session:proof.session,expires:now()+60000},"launch:"+d);
    if(!await launches.put(d,proof.actor,proof.session,enc))return json(409,{ok:false},true);
    return json(200,{grant,launchUrl:RUNTIME+"/oauth/gmail/launch"},true);
   }
   // Top-level form POST, never a third-party cookie fetch.
   if(req.headers.has("authorization"))return json(403,{ok:false});
   const grant=await readGrant(req);if(!grant)return json(400,{ok:false});
   const d=hash(grant),row=await launches.take(d);if(!row)return json(403,{ok:false});
   const record=vault.open(row.ciphertext,"launch:"+d);
   if(!Number.isFinite(record.expires)||record.expires<=now())return json(403,{ok:false});
   const proof=await userProof(record.bearer);
   if(proof?.actor!==record.actor||proof?.session!==record.session||proof.gate!=="authorized"||proof.sessionActive!==true||!Number.isFinite(proof.stepUpAt)||proof.stepUpAt>now()||now()-proof.stepUpAt>300000)return json(403,{ok:false});
   // Start consumes expected generation under the connection lock. The response
   // sets a first-party cookie and returns inert fixture parameters, no real Google redirect.
   return callback(new Request(RUNTIME+"/oauth/gmail/start",{method:"POST",headers:{origin:RUNTIME,authorization:"Bearer "+record.bearer}}),row.generation);
  }catch{return json(503,{ok:false});}
 };
}
