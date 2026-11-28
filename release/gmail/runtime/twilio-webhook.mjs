// Review candidate only: no live entrypoint, no default transport or Twilio credentials.
import {createHmac,timingSafeEqual} from "node:crypto";
import {Buffer} from "node:buffer";
export const TWILIO_INBOUND="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-twilio-inbound";
const us=x=>typeof x==="string"&&/^\+1[2-9][0-9]{9}$/.test(x);
const sid=(x,p)=>typeof x==="string"&&new RegExp("^"+p+"[a-fA-F0-9]{32}$").test(x);
const stop=new Set(["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT","REVOKE","OPT OUT","OPTOUT"]);
const start=new Set(["START","UNSTOP","YES"]);
export function classifyInbound(body,optOutType){
 const b=body.trim().toUpperCase().replace(/\s+/g," ");
 if(optOutType==="STOP"||stop.has(b))return {kind:"stop"};
 if(optOutType==="START"||start.has(b))return {kind:"start"};
 if(optOutType==="HELP"||["HELP","INFO"].includes(b))return {kind:"help"};
 if(optOutType)return {kind:"review"};
 if(/^JOIN [A-F0-9]{24}$/.test(b))return {kind:"join",code:b.slice(5).toLowerCase()};
 // Hold other replies for human review; never treat them as marketing consent.
 return {kind:"review"};
}
export function validTwilioSignature({url,params,authToken,signature}){
 if(url!==TWILIO_INBOUND||typeof authToken!=="string"||!/^[A-Za-z0-9]{32}$/.test(authToken)||typeof signature!=="string"||!/^[A-Za-z0-9+/]{27}=$/.test(signature)||!(params instanceof URLSearchParams))return false;
 const keys=[...params.keys()];if(new Set(keys).size!==keys.length)return false;
 const signed=url+keys.sort().map(k=>k+params.get(k)).join("");
 const expected=createHmac("sha1",authToken).update(signed,"utf8").digest();
 const actual=Buffer.from(signature,"base64");
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
async function readForm(req){
 const n=req.headers.get("content-length");
 if(!req.body||req.headers.has("content-encoding")||(n!==null&&(!/^\d+$/.test(n)||Number(n)>16384))||!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type")||""))throw Error("Invalid form");
 const r=req.body.getReader();let size=0,timer;const chunks=[];
 try{
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Timeout")),2000);});
  while(true){const {done,value}=await Promise.race([r.read(),deadline]);if(done)break;size+=value.byteLength;if(size>16384)throw Error("Size");chunks.push(value);}
  return new URLSearchParams(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{clearTimeout(timer);void r.cancel().catch(()=>{});}
}
const reply=(status,body="")=>new Response(body||null,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Type":"text/xml; charset=utf-8"}});
export function createTwilioInboundFixture({mode,accountSid,serviceSid,number,authToken,record,ready}){
 if(mode!=="isolated-acceptance"||!sid(accountSid,"AC")||!sid(serviceSid,"MG")||!/^\+18(?:00|33|44|55|66|77|88)[0-9]{7}$/.test(number)||!/^[A-Za-z0-9]{32}$/.test(authToken)||typeof record!=="function"||typeof ready!=="function")throw Error("Invalid SMS fixture config");
 return async req=>{
  try{
   if(req.url!==TWILIO_INBOUND||req.method!=="POST"||req.headers.has("origin"))return reply(403);
   const params=await readForm(req);
   if(!validTwilioSignature({url:TWILIO_INBOUND,params,authToken,signature:req.headers.get("x-twilio-signature")}))return reply(403);
   if(params.get("AccountSid")!==accountSid||params.get("MessagingServiceSid")!==serviceSid||params.get("To")!==number||!us(params.get("From"))||!sid(params.get("MessageSid"),"SM"))return reply(403);
   const body=params.get("Body");if(typeof body!=="string"||body.length>1600)return reply(400);
   const event=classifyInbound(body,params.get("OptOutType"));
   // Opt-outs/review remain available even with signup/sending paused.
   // START records provider unblock only; does not enroll or restore local consent.
   if(event.kind==="join"&&!await ready())return reply(200,"<Response/>");
   const ok=await record({messageSid:params.get("MessageSid"),from:params.get("From"),...event,...(event.kind==="review"?{reviewText:body.slice(0,1600)}:{})});
   if(ok!==true)return reply(503);
   // Twilio/carrier handles built-in keyword replies. No duplicate TwiML or API messages.
   return reply(200,"<Response/>");
  }catch{return reply(503);}
 };
}
