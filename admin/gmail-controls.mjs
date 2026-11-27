// Draft administrative integration. Shipping remains blocked until separately approved.
export const GMAIL_RELEASE_ENABLED=false;
export const GMAIL_CONTROL_BASE="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-control/oauth/gmail";
const uuid=x=>typeof x==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const dispositions=["closed-unverified-no-resend","provider-acceptance-observed-no-resend"];
const actions=new Set(["status","disable","disconnect","rotate","review","review-close","prepare"]);
export function createGmailAdminClient({mode,allowed,getBearer,request}){
 // Do not accept global fetch or enable real provider actions in this draft.
 if(mode!=="isolated-acceptance"||typeof allowed!=="function"||typeof getBearer!=="function"||typeof request!=="function"||request===globalThis.fetch)throw Error("Gmail controls are not released");
 return async(action,body,signal)=>{
  if(!actions.has(action)||!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  if(action==="review-close"&&(!body||Object.keys(body).length!==2||!uuid(body.job)||!dispositions.includes(body.disposition)))throw Error("Invalid review");
  if(action!=="review-close"&&body!==undefined)throw Error("Unexpected body");
  const bearer=await getBearer();
  if(typeof bearer!=="string"||!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(bearer)||!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  const headers={Authorization:"Bearer "+bearer};if(body!==undefined)headers["Content-Type"]="application/json";
  const res=await request(GMAIL_CONTROL_BASE+"/"+action,{method:"POST",headers,body:body===undefined?undefined:JSON.stringify(body),credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal});
  if(!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  if(res.status===403)throw Error("Fresh administrator verification required");
  if(!res.ok)throw Error("Control unavailable");
  const v=await res.json();
  if(!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  if(action==="status"){
   if(typeof v.connected!=="boolean"||typeof v.enabled!=="boolean"||v.enabled&&!v.connected)throw Error("Invalid status");
   return {connected:v.connected,enabled:v.enabled};
  }
  if(action==="review"){
   if(!Array.isArray(v.holds)||v.holds.length>50||v.holds.some(x=>!uuid(x.job_id)||typeof x.created_at!=="string"||typeof x.started!=="boolean"||x.outcome!=="ambiguous-hold-no-resend"))throw Error("Invalid review list");
   return {holds:v.holds.map(x=>({job:x.job_id,createdAt:x.created_at,started:x.started}))};
  }
  if(action==="prepare"){
   if(typeof v.grant!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(v.grant)||v.launchUrl!==GMAIL_CONTROL_BASE+"/launch")throw Error("Invalid launch grant");
   return {grant:v.grant,launchUrl:v.launchUrl};
  }
  if(action==="disable"&&v.enabled===false)return {enabled:false};
  if(action==="disconnect"&&v.enabled===false&&v.connected===false&&typeof v.providerRevoked==="boolean")return {connected:false,enabled:false,providerRevoked:v.providerRevoked};
  if(action==="rotate"&&v.ok===true&&v.enabled===false)return {ok:true,enabled:false};
  if(action==="review-close"&&v.ok===true)return {ok:true};
  throw Error("Invalid control result");
 };
}
export function attachGmailControls(root,{allowed,api=null}={}){
 const panel=root?.querySelector("[data-gmail-controls]");if(!panel)return {clear(){}};
 const status=panel.querySelector("[data-gmail-status]"),notice=panel.querySelector("[data-gmail-notice]"),list=panel.querySelector("[data-gmail-holds]");
 const buttons=[...panel.querySelectorAll("[data-gmail-action]")];
 let epoch=0,busy=false,controller=null,connection=null,holds=[];
 function paint(){
  status.textContent=connection?(connection.connected?"Connected":"Disconnected")+" · "+(connection.enabled?"Enabled":"Disabled"):"Not connected to a released runtime";
  for(const b of buttons){const a=b.dataset.gmailAction;b.disabled=!api||!allowed?.()||busy||(a==="disable"&&!connection?.enabled)||(a==="disconnect"&&!connection?.connected)||(a==="rotate"&&(!connection?.connected||connection.enabled));}
  list.replaceChildren();
  for(const row of holds){
   const p=document.createElement("p");p.textContent="Job "+row.job+" · "+(row.started?"Dispatch started":"Reserved")+" · "+row.createdAt;
   const label=document.createElement("label"),select=document.createElement("select");
   select.setAttribute("aria-label","Review disposition for job "+row.job);
   for(const [value,text] of [[dispositions[0],"Close — outcome unverified"],[dispositions[1],"Close — provider acceptance observed"]]){const o=document.createElement("option");o.value=value;o.textContent=text;select.append(o);}
   label.append("Disposition ",select);const button=document.createElement("button");button.type="button";button.textContent="Close without resend";button.disabled=busy||!allowed?.();button.addEventListener("click",()=>void run("review-close",{job:row.job,disposition:select.value}));list.append(p,label,button);
  }
 }
 function clear(){epoch++;controller?.abort();controller=null;busy=false;connection=null;holds=[];notice.textContent="";paint();}
 async function run(action,body){
  if(!api||!allowed?.()||busy)return;
  const version=++epoch;controller=new AbortController();const signal=controller.signal;busy=true;notice.textContent="";paint();
  const current=()=>version===epoch&&allowed()&&!signal.aborted;
  try{
   if(action!=="status"){
    const v=await api(action,body,signal);if(!current())return;
    if(action==="disconnect"&&!v.providerRevoked)notice.textContent="Local connection disabled. Google revocation requires manual verification.";
   }
   const c=await api("status",undefined,signal);if(!current())return;
   const h=await api("review",undefined,signal);if(!current())return;
   connection=c;holds=h.holds;
  }catch{if(current()){connection=null;holds=[];notice.textContent="Control unavailable. Sign in with fresh verification and retry.";}}
  finally{if(version===epoch){busy=false;if(!allowed?.()){connection=null;holds=[];}paint();}}
 }
 for(const b of buttons)b.addEventListener("click",()=>void run(b.dataset.gmailAction));
 paint();return {clear};
}
