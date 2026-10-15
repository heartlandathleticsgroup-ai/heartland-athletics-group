import { createClient } from "npm:@supabase/supabase-js@2";
const allowedOrigins=new Set(["https://heartlandathleticsgroup.com","https://www.heartlandathleticsgroup.com"]);
const allowedTopics=new Set(["gus-macker-2027","enforcers","camps","other-events"]);
function reply(origin:string,status:number,body:unknown){
 return new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json; charset=utf-8","cache-control":"no-store",
 "access-control-allow-origin":allowedOrigins.has(origin)?origin:"https://heartlandathleticsgroup.com",
 "access-control-allow-methods":"POST, OPTIONS",
 "access-control-allow-headers":"content-type,apikey,authorization,x-client-info",
 "vary":"Origin"
 }});
}
function clean(value:unknown,max:number){return typeof value==="string"?value.trim().slice(0,max+1):""}
async function fingerprint(input:string,key:string):Promise<string>{
 const codec=new TextEncoder();
 const secret=await crypto.subtle.importKey("raw",codec.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const hash=await crypto.subtle.sign("HMAC",secret,codec.encode(input));
 return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,"0")).join("");
}
Deno.serve(async req=>{
 const origin=req.headers.get("origin")||"";
 if(req.method==="OPTIONS")return reply(origin,200,{ok:true});
 if(req.method!=="POST"||!allowedOrigins.has(origin))return reply(origin,403,{error:"Request not permitted"});
 if(!req.headers.get("content-type")?.startsWith("application/json"))return reply(origin,415,{error:"Invalid request format"});
 const advertised=Number(req.headers.get("content-length")||"0");
 if(advertised>4096)return reply(origin,413,{error:"Message is too long"});
 let body:Record<string,unknown>;
 try{const raw=await req.text();if(raw.length>4096)return reply(origin,413,{error:"Message is too long"});body=JSON.parse(raw)}
 catch{return reply(origin,400,{error:"Please check the information and try again"})}
 if(clean(body.website,300))return reply(origin,200,{ok:true,message:"Thank you. Your interest request was received."});
 const topic=clean(body.topic,40);
 const name=clean(body.contactName,120),email=clean(body.email,254).toLowerCase();
 const notes=clean(body.notes,700);
 if(!allowedTopics.has(topic)||name.length<2||name.length>120||
    !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)||
    notes.length>700||body.adultConfirmed!==true||body.contactConsent!==true)
   return reply(origin,400,{error:"Enter your name and valid email, and confirm the adult contact permissions."});
 if(/\b(?:password|social security|medical records)\b/i.test(notes))
   return reply(origin,400,{error:"Please do not include sensitive information. Send a shorter general inquiry."});
 const url=Deno.env.get("SUPABASE_URL"),serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!serviceKey)return reply(origin,503,{error:"Interest requests are temporarily unavailable. Please email info@heartlandathleticsgroup.com."});
 const staff=createClient(url,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
 const emailKey=await fingerprint("email:"+email,serviceKey);
 const trustedIp=req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||"";
 const ipKey=trustedIp?await fingerprint("ip:"+trustedIp,serviceKey):"unknown";
 const lastWeek=new Date(Date.now()-7*86400000).toISOString();
 const lastDay=new Date(Date.now()-86400000).toISOString();
 const [emailResults,ipResults]=await Promise.all([
  staff.from("hag_interest_requests").select("id",{count:"exact",head:true}).eq("email_fingerprint",emailKey).gte("created_at",lastWeek),
  trustedIp?staff.from("hag_interest_requests").select("id",{count:"exact",head:true}).eq("ip_fingerprint",ipKey).gte("created_at",lastDay):Promise.resolve({count:0,error:null})
 ]);
 if(emailResults.error||ipResults.error)return reply(origin,503,{error:"Unable to process request right now. Please try later."});
 if((emailResults.count||0)>=3||(ipResults.count||0)>=12)return reply(origin,429,{error:"Too many recent requests. Please contact H.A.G. by email instead."});
 const recent=await staff.from("hag_interest_requests").select("id").eq("topic",topic)
  .eq("email_fingerprint",emailKey).gte("created_at",lastWeek).limit(1);
 if(recent.error)return reply(origin,503,{error:"Unable to process request right now."});
 if(recent.data?.length)return reply(origin,200,{ok:true,message:"Thank you. Your interest request has been recorded."});
 const added=await staff.from("hag_interest_requests").insert({
  topic,contact_name:name,contact_email:email,notes:notes||null,
  adult_confirmed:true,contact_consent:true,
  email_fingerprint:emailKey,ip_fingerprint:ipKey,status:"new"
 });
 if(added.error)return reply(origin,503,{error:"Your request could not be saved. Please try again."});
 return reply(origin,200,{ok:true,message:"Thank you. H.A.G. received your interest request. This is not an event registration or reservation."});
});
