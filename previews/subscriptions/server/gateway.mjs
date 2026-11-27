// UNPUBLISHED. No network server, provider credentials or production entry point.
import {validateRequest,validatePreferenceAccess,TOPICS,CONSENT_VERSION} from "../consent.mjs";
import {isIP} from "node:net";
const ORIGIN="https://heartlandathleticsgroup.com", MAX=8192;
function canonicalSource(s){if(typeof s!=="string"||!isIP(s))return null;return isIP(s)===4?s:new URL("http://["+s+"]/").hostname.slice(1,-1);}
// Bounded per-process ingress budget; distributed database budget is separate.
export function createIngressGuard({clock=Date.now}={}){
 let minute=-1,total=0;const counts=new Map();
 return src=>{const key=canonicalSource(src);if(!key)return false;const now=Math.floor(clock()/60000);if(now!==minute){minute=now;total=0;counts.clear();}if(total>=600)return false;total++;const n=counts.get(key)||0;if(n>=40)return false;counts.set(key,n+1);return true;};
}
const token=v=>typeof v==="string"&&/^[0-9a-f]{64}$/.test(v);
const id=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact=(v,ks)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
const codes=new Set(TOPICS.map(x=>x[0]));
const topics=v=>Array.isArray(v)&&v.length<=9&&new Set(v).size===v.length&&v.every(x=>codes.has(x));
const fixture=(c,d)=>c==="email"?d.endsWith(".invalid"):/^\+1[2-9][0-9]{2}55501[0-9]{2}$/.test(d);
export const GENERIC="If the request is eligible, instructions can be provided through the selected contact method.";
function response(status,data,origin=false){
 const headers={"Cache-Control":"no-store","Pragma":"no-cache","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Content-Type":"application/json; charset=utf-8","Vary":"Origin"};
 if(origin)headers["Access-Control-Allow-Origin"]=ORIGIN;
 if(status===204){headers["Access-Control-Allow-Methods"]="POST";headers["Access-Control-Allow-Headers"]="Content-Type";return new Response(null,{status,headers});}
 return new Response(JSON.stringify(data),{status,headers});
}
async function body(req){
 const len=req.headers.get("content-length");
 if(len!==null&&(!/^\d+$/.test(len)||Number(len)>MAX))throw Error("size");
 if(!req.body)throw Error("body");
 const reader=req.body.getReader(),chunks=[];let size=0,timer;
 try{
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("timeout")),2000)});
  while(true){
   const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;
   size+=value.byteLength;if(size>MAX)throw Error("size");chunks.push(value);
  }
  const bytes=new Uint8Array(size);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.byteLength;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function createGateway({db,delivery,source,ingress}){
 // Required ingress guard handles all requests including malformed bodies.
 // Runtime must supply canonical trusted source; never read forwarded IP headers here.
 if(!db||!delivery||delivery.mode!=="simulation"||typeof source!=="function"||typeof ingress!=="function")throw Error("Isolated simulation dependencies required");
 return async req=>{
  const origin=req.headers.get("origin")===ORIGIN;
  const bad=()=>response(400,{message:"Invalid request."},origin);
  try{
   if(!origin)return response(403,{message:"Request not allowed."});
   const url=new URL(req.url);if(url.protocol!=="https:"||url.pathname!=="/subscriptions"||url.search)return bad();
   if(req.method==="OPTIONS"){
    if(req.headers.get("access-control-request-method")!=="POST"||!["","content-type"].includes((req.headers.get("access-control-request-headers")||"").trim().toLowerCase()))return bad();
    return response(204,null,true);
   }
   if(req.method!=="POST")return response(405,{message:"Request not allowed."},true);
   const src=canonicalSource(source(req));if(!src)return response(503,{message:"Service unavailable."},true);
   if(!await ingress(src))return response(429,{message:"Try again later."},true);
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type")||"")||req.headers.has("content-encoding"))return bad();
   let x;try{x=await body(req);}catch{return bad();}
   if(!x||typeof x.action!=="string")return bad();
   let data,items;
   try{
    switch(x.action){
     case "subscribe":
      if(!exact(x,["action","requestId","version","form"])||!id(x.requestId)||x.version!==CONSENT_VERSION)throw Error();
      data=validateRequest(x.form);items=data.requests.map(v=>({...v,name:data.name,adult:true,purpose:"confirm"}));break;
     case "access":
      if(!exact(x,["action","requestId","purpose","form"])||!id(x.requestId)||!["manage","unsubscribe"].includes(x.purpose))throw Error();
      items=[{...validatePreferenceAccess(x.form),purpose:x.purpose}];break;
     case "confirm":case "manage":case "unsubscribe":
      if(!exact(x,["action","token"])||!token(x.token))throw Error();break;
     case "edit":
      if(!exact(x,["action","token","add","remove","adult","consent","version"])||!token(x.token)||!topics(x.add)||!topics(x.remove)||x.add.some(t=>x.remove.includes(t))||!x.add.length&&!x.remove.length||typeof x.adult!=="boolean"||typeof x.consent!=="boolean"||x.version!==CONSENT_VERSION||(x.add.length&&(!x.adult||!x.consent)))throw Error();break;
     default:throw Error();
    }
    if(items?.some(v=>!fixture(v.channel,v.destination)))throw Error();
   }catch{return bad();}
   const issuing=!!items;
   const generic=()=>response(202,{message:GENERIC},true);
   try{
    if(!await db.budget(src,x.action))return issuing?generic():response(429,{message:"Try again later."},true);
    if(issuing){
     // One channel per atomic issue key; duplicates never repeat simulated delivery.
     for(const item of items){
      try{const raw=await db.issue(x.requestId,x.action,item);
      if(token(raw))await delivery.accept({channel:item.channel,destination:item.destination,purpose:item.purpose,token:raw});}catch{/* Do not leak outcomes or skip another channel. */}
     }
     return generic();
    }
    if(x.action==="edit"){
     const ok=await db.edit(x);
     return response(200,{ok:ok===true},true);
    }
    const result=await db.redeem(x.token,x.action);
    if(x.action!=="manage")return response(200,{ok:result?.ok===true},true);
    if(!result||!["email","sms"].includes(result.channel)||typeof result.suppressed!=="boolean"||!token(result.edit_token)||!Array.isArray(result.preferences)||result.preferences.length>9||result.preferences.some(v=>!codes.has(v?.topic)||!["pending","active","withdrawn"].includes(v.status)))return response(200,{ok:false},true);
    return response(200,{ok:true,channel:result.channel,suppressed:result.suppressed,preferences:result.preferences.map(v=>({topic:v.topic,status:v.status})),editToken:result.edit_token},true);
   }catch{return issuing?generic():response(503,{message:"Service unavailable."},true);}
  }catch{return response(503,{message:"Service unavailable."},origin);}
 };
}
export function createSimulatedDelivery(){
 // In-process test capture only, bounded; no transport or logs. Discard after test.
 const captured=[];
 return {mode:"simulation",async accept(v){if(!fixture(v.channel,v.destination)||!token(v.token))throw Error("Invalid simulation fixture");if(captured.length>=100)throw Error("Simulation full");captured.push(Object.freeze({...v}));},drain(){return captured.splice(0);}};
}
