// Isolated outbound acceptance. No production entrypoint, network default or credentials.
import {Buffer} from "node:buffer";
export const SMS_ACK="Heartland Athletics Group: Your text subscription is confirmed! You'll receive updates based on your selected interests. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help.";
export const STATUS_URL="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-twilio-status";
const sid=(v,p)=>typeof v==="string"&&new RegExp("^"+p+"[a-fA-F0-9]{32}$").test(v);
const phone=v=>typeof v==="string"&&/^\+1[2-9][0-9]{9}$/.test(v);
const id=v=>typeof v==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/.test(v);
export function createTwilioAckFixture({mode,accountSid,serviceSid,apiKeySid,apiSecret,fetchFixture,ready,claim,start,finish}){
 if(mode!=="isolated-acceptance"||fetchFixture===globalThis.fetch||typeof fetchFixture!=="function"||!sid(accountSid,"AC")||!sid(serviceSid,"MG")||!sid(apiKeySid,"SK")||typeof apiSecret!=="string"||!/^[A-Za-z0-9]{32}$/.test(apiSecret)||[ready,claim,start,finish].some(v=>typeof v!=="function"))throw Error("SMS disabled");
 const url="https://api.twilio.com/2010-04-01/Accounts/"+accountSid+"/Messages.json";
 return async()=>{
  if(!await ready())return "disabled";
  const j=await claim();if(!j)return "empty";
  if(!id(j.ticket)||!phone(j.destination))return "held";
  let result="held",providerSid=null,controller=new AbortController(),timer;
  try{
   if(!await start(j.ticket))result="cancelled";
   else{
    const task=(async()=>{
     const r=await fetchFixture(url,{method:"POST",redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",signal:controller.signal,headers:{Authorization:"Basic "+Buffer.from(apiKeySid+":"+apiSecret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({To:j.destination,MessagingServiceSid:serviceSid,Body:SMS_ACK,StatusCallback:STATUS_URL}).toString()});
     if(r.redirected||r.status>=300&&r.status<400)throw Error("Redirect");
     const reader=r.body?.getReader();if(!reader)throw Error("Response missing");let n=0,parts=[];
     try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>32768)throw Error("Response size");parts.push(value);}}finally{void reader.cancel().catch(()=>{});}
     const b=JSON.parse(Buffer.concat(parts).toString("utf8"));
     if(r.status===201&&sid(b?.sid,"SM")&&b.account_sid===accountSid&&b.messaging_service_sid===serviceSid&&b.to===j.destination){providerSid=b.sid;return "accepted";}
     if(r.status===400&&b?.code===21610)return "provider-blocked";
     return "held";
    })();
    result=await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("Timeout"));},5000);})]);
   }
  }catch{result="held";}finally{clearTimeout(timer);}
  // Never retry a reserved or ambiguous attempt.
  try{if(!await finish(j.ticket,result,providerSid))return "held";}catch{return "held";}
  return result;
 };
}
