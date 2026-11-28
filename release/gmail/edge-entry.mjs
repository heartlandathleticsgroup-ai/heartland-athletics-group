// Entry point for a future isolated deployment package. No hosted mutation.
// Importing this file does not enable authorization or email.
import postgres from "npm:postgres@3.4.9";
import {createReleaseRuntime} from "./runtime/runtime.mjs";
const read=name=>Deno.env.get(name);
const key=(name)=>({key:read(name),version:read(name+"_VERSION")});
const optionalKey=name=>read(name)||read(name+"_VERSION")?key(name):null;
let runtime;
function getRuntime(){
 if(runtime)return runtime;
 const runtimeState=read("HAG_GMAIL_RUNTIME_STATE");
 const config=runtimeState!=="approved-runtime"?{runtime:"disabled"}:{
  runtime:runtimeState,oauth:read("HAG_GMAIL_OAUTH_ENABLED")==="true",send:read("HAG_GMAIL_SEND_ENABLED")==="true",preferences:read("HAG_PREFERENCES_ENABLED")==="true",signup:read("HAG_SUBSCRIPTIONS_SIGNUP_ENABLED")==="true",
  controlDb:read("HAG_GMAIL_CONTROL_DATABASE_URL"),dispatchDb:read("HAG_GMAIL_DISPATCH_DATABASE_URL"),gatewayDb:read("HAG_SUBSCRIPTION_DATABASE_URL"),ca:read("HAG_DATABASE_CA_PEM"),
  clientId:read("HAG_GMAIL_CLIENT_ID"),clientSecret:read("HAG_GMAIL_CLIENT_SECRET"),postalFooter:read("HAG_PRIVATE_POSTAL_FOOTER"),
  publishableKey:read("HAG_PROJECT_PUBLISHABLE_KEY"),workerKey:read("HAG_GMAIL_WORKER_KEY"),vault:key("HAG_GMAIL_VAULT_KEY"),nextVault:optionalKey("HAG_GMAIL_NEXT_VAULT_KEY"),outbox:key("HAG_EMAIL_OUTBOX_KEY"),priorOutbox:optionalKey("HAG_EMAIL_PRIOR_OUTBOX_KEY")
 };
 runtime=createReleaseRuntime({config,postgres,fetcher:globalThis.fetch.bind(globalThis)});
 return runtime;
}
// Supabase's internal router may strip /functions/v1 from the request path.
const names={control:"hag-gmail-control",worker:"hag-gmail-worker",preferences:"hag-subscriptions"};
export function canonicalEdgeRequest(req,kind){
 const name=names[kind];if(!name)throw Error("Invalid entrypoint");
 const url=new URL(req.url),p=url.pathname,short="/"+name,long="/functions/v1/"+name;
 const path=p===short||p.startsWith(short+"/")?"/functions/v1"+p:p===long||p.startsWith(long+"/")?p:null;
 if(!path)throw Error("Unexpected function route");
 const init={method:req.method,headers:req.headers};if(req.body&&req.method!=="GET"&&req.method!=="HEAD"){init.body=req.body;init.duplex="half";}
 return new Request("https://unrqbfngcgvqnytxbtgj.supabase.co"+path+url.search,init);
}
export function handler(kind){
 if(!["control","worker","preferences"].includes(kind))throw Error("Invalid runtime entrypoint");
 return async req=>{
  try{return await getRuntime()[kind](canonicalEdgeRequest(req,kind));}
  catch{return new Response('{"ok":false}',{status:503,headers:{"Content-Type":"application/json","Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
 };
}
