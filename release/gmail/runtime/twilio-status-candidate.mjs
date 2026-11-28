// Isolated status acceptance only. No real provider requests, storage or production entrypoint.
import {createHmac,timingSafeEqual} from "node:crypto";
import {Buffer} from "node:buffer";
export const STATUS_URL="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-twilio-status";
const sid=(v,p)=>typeof v==="string"&&new RegExp("^"+p+"[0-9a-fA-F]{32}$").test(v);
const phone=v=>typeof v==="string"&&/^\+1[2-9][0-9]{9}$/.test(v);
const statuses=new Set(["accepted","queued","sending","sent","delivered","undelivered","failed","canceled"]);
const rank={accepted:0,queued:1,sending:2,sent:3,delivered:4,undelivered:4,failed:4,canceled:4};
const terminal=s=>rank[s]===4;
// Pure reducer: preserve terminal outcomes; conflicting terminal receipts require staff review.
// A durable DB transaction must apply this rule under a row lock and dedupe receipts.
export function reduceStatus(current,next){
 if(!statuses.has(next)||current!==null&&!statuses.has(current))throw Error("Invalid status");
 if(current===null)return {status:next,review:false};
 if(terminal(current))return {status:current,review:terminal(next)&&next!==current};
 return {status:rank[next]>rank[current]?next:current,review:false};
}
const response=status=>new Response(null,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
async function read(req){
 const length=req.headers.get("content-length");
 if(!req.body||req.headers.has("content-encoding")||length!==null&&(!/^\d+$/.test(length)||Number(length)>16384)||!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type")||""))return null;
 let size=0,timer;const chunks=[],reader=req.body.getReader();
 try{
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Timeout")),2000);});
  while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>16384)return null;chunks.push(value);}
  return new URLSearchParams(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
// Fixture compatibility validator; production must use a pinned, reviewed Twilio SDK
// or validate against official SDK vectors before enabling any externally reachable route.
export function createStatusFixture({mode,accountSid,serviceSid,number,authToken,record}){
 if(mode!=="isolated-acceptance"||!sid(accountSid,"AC")||!sid(serviceSid,"MG")||!/^\+18(?:00|33|44|55|66|77|88)[0-9]{7}$/.test(number)||typeof authToken!=="string"||!/^[A-Za-z0-9]{32}$/.test(authToken)||typeof record!=="function")throw Error("Invalid fixture config");
 return async req=>{
  if(req.url!==STATUS_URL||req.method!=="POST"||req.headers.has("origin"))return response(403);
  let p;try{p=await read(req);}catch{return response(400);}
  if(!p)return response(400);
  const keys=[...p.keys()];if(new Set(keys).size!==keys.length)return response(400);
  const signature=req.headers.get("x-twilio-signature");
  if(typeof signature!=="string"||!/^[A-Za-z0-9+/]{27}=$/.test(signature))return response(403);
  const expected=createHmac("sha1",authToken).update(STATUS_URL+keys.sort().map(k=>k+p.get(k)).join(""),"utf8").digest();
  const actual=Buffer.from(signature,"base64");
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return response(403);
  if(p.get("AccountSid")!==accountSid||p.get("MessagingServiceSid")!==serviceSid||p.get("From")!==number||!phone(p.get("To"))||!sid(p.get("MessageSid"),"SM"))return response(403);
  const status=p.get("MessageStatus"),errorCode=p.get("ErrorCode")||null;
  if(!statuses.has(status)||errorCode!==null&&!/^\d{1,8}$/.test(errorCode))return response(400);
  // Never create a subscriber or authorize a send from a delivery receipt.
  // Record must bind the SID AND destination to a known reserved outbound attempt,
  // hold early/unknown receipts safely, and reconcile opt-out errors before dispatch.
  try{return response(await record({messageSid:p.get("MessageSid"),destination:p.get("To"),status,errorCode})===true?204:503);}catch{return response(503);}
 };
}
