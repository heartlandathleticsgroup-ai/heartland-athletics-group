import postgres from "npm:postgres@3.4.9";
import {createReleaseExecutor} from "./driver.mjs";
import {createSignup} from "./signup-core.mjs";
const enabled=Deno.env.get("HAG_EMAIL_SIGNUP_ENABLED")==="true";
let handler;
Deno.serve(async req=>{
 try{
  if(!handler){
   if(!enabled)handler=createSignup({enabled:false});
   else {
    const executor=createReleaseExecutor({postgres,url:Deno.env.get("HAG_SUBSCRIPTION_DATABASE_URL"),ca:Deno.env.get("HAG_DATABASE_CA_PEM"),kind:"gateway"});
    handler=createSignup({enabled:true,db:async d=>{
     const r=await executor.execute("select hag_private.subscription_public_email_signup_v1($1::uuid,$2,$3,$4::text[],$5) as value",[d.requestId,d.name,d.destination,d.topics,"hag-subscriber-notice-v1"]);
     return r.rows[0]?.value===true;
    }});
   }
  }
  return await handler(req);
 }catch{return new Response('{"ok":false}',{status:503,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"https://heartlandathleticsgroup.com","Vary":"Origin"}})}
});
