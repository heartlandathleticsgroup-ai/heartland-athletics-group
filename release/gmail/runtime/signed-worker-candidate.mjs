// Isolated scheduler contract only; no listener, credentials or scheduling.
import {createHmac,timingSafeEqual} from "node:crypto";
import {Buffer} from "node:buffer";
export const WORKER_URL="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-worker";
const nonceOk=x=>typeof x==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/.test(x);
const keyOk=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)&&new Set(x).size>=8;
export function workerSignature({key,timestamp,nonce}){
 if(!keyOk(key)||!Number.isSafeInteger(timestamp)||!nonceOk(nonce))throw Error("Invalid scheduler input");
 return createHmac("sha256",Buffer.from(key,"hex")).update("hag-email-worker-v1\nPOST\n"+WORKER_URL+"\n"+timestamp+"\n"+nonce,"utf8").digest("hex");
}
export function createSignedWorkerFixture({mode,key,ready,consume,pump,clock=Date.now}){
 if(mode!=="isolated-acceptance"||!keyOk(key)||typeof ready!=="function"||typeof consume!=="function"||typeof pump!=="function")throw Error("Worker disabled");
 const res=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"Cache-Control":"no-store","Content-Type":"application/json","Referrer-Policy":"no-referrer"}});
 return async req=>{
  try{
   if(req.url!==WORKER_URL||req.method!=="POST"||req.headers.has("origin")||req.headers.has("content-encoding"))return res(403,{ok:false});
   const stamp=req.headers.get("x-hag-timestamp"),nonce=req.headers.get("x-hag-nonce"),sig=req.headers.get("x-hag-signature");
   if(!/^\d{10}$/.test(stamp||"")||!nonceOk(nonce)||!/^([a-f0-9]{64})$/.test(sig||""))return res(403,{ok:false});
   const timestamp=Number(stamp),now=Math.floor(clock()/1000);
   if(timestamp>now+5||now-timestamp>60||!timingSafeEqual(Buffer.from(sig,"hex"),Buffer.from(workerSignature({key,timestamp,nonce}),"hex")))return res(403,{ok:false});
   // Fixed empty JSON only; prevent arbitrary work injection.
   const reader=req.body?.getReader();if(!reader)return res(400,{ok:false});
   let timer,n=0;const chunks=[];
   try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("timeout")),1000);});while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;n+=value.byteLength;if(n>32)return res(400,{ok:false});chunks.push(value);}if(!/^\s*\{\s*\}\s*$/.test(Buffer.concat(chunks).toString("utf8")))return res(400,{ok:false});}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
   if(!await ready())return res(503,{ok:false});
   if(!await consume(nonce,timestamp))return res(409,{ok:false});
   const outcome=await pump();
   return res(200,{ok:true,outcome:["empty","accepted-not-delivered","ambiguous-hold-no-resend","not-reserved","authorization-required","permanent-or-configuration-review","hold-quota-or-policy-review","unavailable","key-unavailable"].includes(outcome)?outcome:"unavailable"});
  }catch{return res(503,{ok:false});}
 };
}
