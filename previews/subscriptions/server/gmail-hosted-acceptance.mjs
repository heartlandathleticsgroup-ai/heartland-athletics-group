// Exact proposed Supabase Edge path adapter. All I/O mocked; no listener.
import {CONTROL_BASE,CALLBACK_URI,createProductionProtocol,createUserProofRpc} from "./gmail-production-protocol.mjs";
import {createGmailBridgedRuntime} from "./gmail-runtime.mjs";
const ADMIN="https://heartlandathleticsgroup.com",FIXTURE="https://preview.invalid";
const controlRoutes=new Set(["status","disable","disconnect","review","review-close","rotate"]);
const base=new URL(CONTROL_BASE);
const common={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
function reject(status=403,cors=false){return new Response(JSON.stringify({ok:false}),{status,headers:{...common,"Content-Type":"application/json",...(cors?{"Access-Control-Allow-Origin":ADMIN,Vary:"Origin"}:{})}});}
export function createHostedRouteAdapter({mode,handle}){
 if(mode!=="isolated-acceptance"||typeof handle!=="function")throw Error("Isolated host adapter only");
 return async req=>{
  try{
   const u=new URL(req.url),origin=req.headers.get("origin");
   if(u.origin!==base.origin||!u.pathname.startsWith(base.pathname+"/oauth/gmail/"))return reject(404);
   const path=u.pathname.slice(base.pathname.length),route=path.slice("/oauth/gmail/".length);
   const control=controlRoutes.has(route),cors=control||route==="prepare";
   if(!control&&!["prepare","launch","callback","result"].includes(route))return reject(404);
   if(cors&&origin!==ADMIN)return reject();
   if(cors&&req.method==="OPTIONS"){
    const headers=(req.headers.get("access-control-request-headers")||"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
    if(req.headers.get("access-control-request-method")!=="POST"||!headers.includes("authorization")||headers.some(x=>!["authorization","content-type"].includes(x)))return reject(403,true);
    return new Response(null,{status:204,headers:{...common,"Access-Control-Allow-Origin":ADMIN,"Access-Control-Allow-Methods":"POST","Access-Control-Allow-Headers":"Authorization, Content-Type",Vary:"Origin"}});
   }
   if((cors||route==="launch")&&(req.method!=="POST"||origin!==ADMIN||u.search))return reject(403,cors);
   if((route==="callback"||route==="result")&&req.method!=="GET")return reject(405);
   const h=new Headers();
   // Only explicitly allowed inbound headers; ignore forwarded identity and host.
   for(const key of ["authorization","content-type","content-encoding","cookie"])if(req.headers.has(key))h.set(key,req.headers.get(key));
   if(origin)h.set("origin",control?FIXTURE:origin);
   // The trusted outer adapter has verified the admin origin before rewriting.
   const init={method:req.method,headers:h};if(req.body&&req.method==="POST"){init.body=req.body;init.duplex="half";}
   const response=await handle(new Request(FIXTURE+path+u.search,init));
   const headers=new Headers(response.headers);for(const [k,v] of Object.entries(common))headers.set(k,v);
   if(cors){headers.set("Access-Control-Allow-Origin",ADMIN);headers.set("Vary","Origin");}
   if(route==="prepare"&&response.status===200){const v=await response.json();if(typeof v.grant!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(v.grant))return reject(502,true);return new Response(JSON.stringify({grant:v.grant,launchUrl:CONTROL_BASE+"/oauth/gmail/launch"}),{status:200,headers});}
   if(route==="launch"&&response.status===200){
    const v=await response.json(),p=v.parameters;
    if(!p||p.redirect_uri!==CALLBACK_URI||p.client_id!=="fixture.apps.googleusercontent.com"||p.scope!=="https://www.googleapis.com/auth/gmail.send"||p.response_type!=="code"||p.code_challenge_method!=="S256"||!/^[A-Za-z0-9_-]{43}$/.test(p.state||"")||!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge||""))return reject(502);
    // Real launch response would redirect to Google, but this acceptance
    // harness deliberately returns inert parameters and never starts OAuth.
    return new Response(JSON.stringify({isolated:true,parameters:p}),{status:200,headers});
   }
   if(route==="callback"){
    const location=headers.get("location");
    if(response.status!==303||!/^https:\/\/preview\.invalid\/oauth\/gmail\/result\?status=(complete|failed)$/.test(location||""))return reject(502);
    headers.set("location",CONTROL_BASE+location.slice(FIXTURE.length));
   }
   return new Response(response.body,{status:response.status,headers});
  }catch{return reject(503);}
 };
}
export function createHostedAcceptanceRuntime({mode,fetchFixture,publishableKey,clientId,clientSecret,postalFooter,...options}){
 if(mode!=="isolated-acceptance")throw Error("No deployed runtime");
 const protocol=createProductionProtocol({mode,fetchFixture,clientId,clientSecret,postalFooter});
 const userRpc=createUserProofRpc({mode,fetchFixture,publishableKey});
 const runtime=createGmailBridgedRuntime({...options,mode:"isolated-test",clientId,clientSecret,protocol,userRpc});
 return {handle:createHostedRouteAdapter({mode,handle:runtime.handle}),pump:runtime.pump};
}
