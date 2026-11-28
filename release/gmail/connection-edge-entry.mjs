// Only deployed to hag-gmail-control. The other two hosted functions retain
// their independent, previously tested source-level hard locks.
import postgres from "npm:postgres@3.4.9";
import {createConnectionOnly} from "./runtime/connection-only.mjs";
const base="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-control";
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const unavailable=()=>new Response('{"ok":false}',{status:503,headers:{...headers,"Content-Type":"application/json"}});
let runtime;
function config(){
 const read=name=>Deno.env.get(name);
 // Fail closed if any prohibited capability flag is absent or not exactly false.
 if(["HAG_GMAIL_SEND_ENABLED","HAG_PREFERENCES_ENABLED","HAG_SPORT_PREFERENCES_ENABLED"].some(n=>read(n)!=="false"))throw Error("Delivery flags must remain false");
 const state=read("HAG_GMAIL_RUNTIME_STATE"),oauth=read("HAG_GMAIL_OAUTH_ENABLED");
 if(!((state==="disabled"&&oauth==="false")||(state==="approved-runtime"&&oauth==="true")))throw Error("Invalid connection release state");
 return {runtime:state,oauth:oauth==="true",send:false,preferences:false,sportPreferences:false,controlDb:read("HAG_GMAIL_CONTROL_DATABASE_URL"),ca:read("HAG_DATABASE_CA_PEM"),clientId:read("HAG_GMAIL_CLIENT_ID"),clientSecret:read("HAG_GMAIL_CLIENT_SECRET"),postalFooter:read("HAG_PRIVATE_POSTAL_FOOTER"),publishableKey:read("HAG_PROJECT_PUBLISHABLE_KEY"),vault:{key:read("HAG_GMAIL_VAULT_KEY"),version:read("HAG_GMAIL_VAULT_KEY_VERSION")}};
}
export function handler(req){
 return (async()=>{
  try{
   const u=new URL(req.url),short="/hag-gmail-control",long="/functions/v1/hag-gmail-control";
   const suffix=u.pathname.startsWith(short+"/")?u.pathname.slice(short.length):u.pathname.startsWith(long+"/")?u.pathname.slice(long.length):null;
   if(!suffix)return unavailable();
   if(!runtime)runtime=createConnectionOnly({config:config(),postgres,fetcher:globalThis.fetch.bind(globalThis)});
   // Minimal preflight confirms hosted secret parsing and validated connection
   // configuration only. No database or Google call, no private data output.
   if(suffix==="/readiness"&&req.method==="GET"&&!u.search)return new Response(null,{status:204,headers});
   const init={method:req.method,headers:req.headers};if(req.body&&req.method!=="GET"&&req.method!=="HEAD"){init.body=req.body;init.duplex="half";}
   return await runtime.handle(new Request(base+suffix+u.search,init));
  }catch{return unavailable();}
 })();
}
