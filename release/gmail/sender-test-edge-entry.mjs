import postgres from "npm:postgres@3.4.9";
import {createSenderTestRoute} from "./runtime/sender-test-route.mjs";
let runtime;
const get=n=>Deno.env.get(n);
export async function handler(req){
 try{
  if(["HAG_GMAIL_SEND_ENABLED","HAG_PREFERENCES_ENABLED","HAG_SPORT_PREFERENCES_ENABLED"].some(n=>get(n)!=="false")||get("HAG_GMAIL_RUNTIME_STATE")!=="approved-runtime"||get("HAG_GMAIL_OAUTH_ENABLED")!=="true")throw Error("Delivery lock invalid");
  if(!runtime)runtime=createSenderTestRoute({config:{runtime:"approved-runtime",oauth:true,send:false,preferences:false,sportPreferences:false,dispatchDb:get("HAG_GMAIL_DISPATCH_DATABASE_URL"),ca:get("HAG_DATABASE_CA_PEM"),vault:{key:get("HAG_GMAIL_VAULT_KEY"),version:get("HAG_GMAIL_VAULT_KEY_VERSION")},clientId:get("HAG_GMAIL_CLIENT_ID"),clientSecret:get("HAG_GMAIL_CLIENT_SECRET"),postalFooter:get("HAG_PRIVATE_POSTAL_FOOTER"),publishableKey:get("HAG_PROJECT_PUBLISHABLE_KEY")},postgres,fetcher:globalThis.fetch.bind(globalThis)});
  return await runtime(req);
 }catch{return new Response(null,{status:503,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});}
}
