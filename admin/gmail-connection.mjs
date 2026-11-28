export const GMAIL_CONTROL_BASE="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-control/oauth/gmail";
const actions=new Set(["status","prepare","disconnect","sender-test"]);
const TEST_ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-gmail-sender-test/run";
const outcomes=new Set(["accepted-not-delivered","ambiguous-hold-no-resend","authorization-required","provider-rejected","not-authorized"]);
export function createGmailAdminClient({allowed,getBearer,request}){
 if(typeof allowed!=="function"||typeof getBearer!=="function"||typeof request!=="function")throw Error("Invalid Gmail controls");
 return async(action,signal)=>{
  if(!actions.has(action)||!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  const bearer=await getBearer();if(typeof bearer!=="string"||bearer.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)||!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  const res=await request(action==="sender-test"?TEST_ENDPOINT:GMAIL_CONTROL_BASE+"/"+action,{method:"POST",headers:{Authorization:"Bearer "+bearer},credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal});
  if(!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  if(action==="sender-test"){const v=await res.json();if(!allowed()||signal?.aborted||!outcomes.has(v?.outcome))throw Error("Test outcome unavailable");return {outcome:v.outcome};}
  if(!res.ok)throw Error(res.status===403?"Fresh administrator verification required":"Connection unavailable");
  const v=await res.json();if(!allowed()||signal?.aborted)throw Error("Administrative access unavailable");
  if(action==="status"&&typeof v.connected==="boolean"&&v.enabled===false)return {connected:v.connected};
  if(action==="prepare"&&typeof v.grant==="string"&&/^[A-Za-z0-9_-]{43}$/.test(v.grant)&&v.launchUrl===GMAIL_CONTROL_BASE+"/launch")return {grant:v.grant,launchUrl:v.launchUrl};
  if(action==="disconnect"&&v.connected===false&&v.enabled===false&&typeof v.providerRevoked==="boolean")return {connected:false,providerRevoked:v.providerRevoked};
  throw Error("Unexpected connection result");
 };
}
export function submitGmailLaunch({grant,launchUrl}){
 if(!/^[A-Za-z0-9_-]{43}$/.test(grant)||launchUrl!==GMAIL_CONTROL_BASE+"/launch")throw Error("Invalid launch");
 const form=document.createElement("form");form.method="POST";form.action=launchUrl;form.target="_self";form.hidden=true;
 const input=document.createElement("input");input.type="hidden";input.name="grant";input.value=grant;form.append(input);document.body.append(form);form.submit();window.addEventListener("pagehide",()=>{input.value="";form.remove();},{once:true});
}
export function attachGmailControls(root,{allowed,api,launch=submitGmailLaunch}){
 const panel=root?.querySelector("[data-gmail-controls]");if(!panel)return {clear(){},refreshAccess(){}};
 const status=panel.querySelector("[data-gmail-status]"),notice=panel.querySelector("[data-gmail-notice]"),buttons=[...panel.querySelectorAll("[data-gmail-action]")];
 let epoch=0,busy=false,controller=null,connection=null,testAttempted=false;
 function paint(){
  status.textContent=connection?(connection.connected?"Connected — delivery disabled; sender review pending":"Disconnected — delivery disabled"):"Check connection status.";
  for(const b of buttons){const a=b.dataset.gmailAction;b.disabled=!allowed()||busy||(a==="prepare"&&(!connection||connection.connected))||(a==="disconnect"&&!connection?.connected)||(a==="sender-test"&&(!connection?.connected||testAttempted));}
 }
 function clear(){epoch++;controller?.abort();controller=null;busy=false;connection=null;notice.textContent="";paint();}
 async function run(action){
  if(!allowed()||busy||!actions.has(action))return;
  if(action==="sender-test"){if(testAttempted||!connection?.connected)return;testAttempted=true;}
  const version=++epoch;controller=new AbortController();const signal=controller.signal;busy=true;notice.textContent="";paint();
  const current=()=>version===epoch&&allowed()&&!signal.aborted;
  try{
   const v=await api(action,signal);if(!current())return;
   if(action==="prepare"){launch(v);return;}
   if(action==="sender-test"){notice.textContent=v.outcome==="accepted-not-delivered"?"Gmail accepted the one test email. Check your inbox; delivery is not yet verified.":v.outcome==="not-authorized"?"Test unavailable, expired or already used. Do not retry.":v.outcome==="authorization-required"?"Test authorization could not be validated. Do not retry.":v.outcome==="provider-rejected"?"Google rejected the test. Do not retry.":"Outcome uncertain. Do not retry.";return;}
   connection=v;
   if(action==="disconnect"&&!v.providerRevoked)notice.textContent="Locally disconnected. Google revocation requires manual verification.";
  }catch(e){if(current()){connection=null;notice.textContent=action==="sender-test"?"Test outcome unavailable. Do not retry.":e.message==="Fresh administrator verification required"?"Sign out and sign in again, then refresh connection status.":"Connection unavailable. No email was sent.";}}
  finally{if(version===epoch){busy=false;if(!allowed())connection=null;paint();}}
 }
 for(const b of buttons)b.addEventListener("click",()=>void run(b.dataset.gmailAction));
 paint();return {clear,refreshAccess:paint};
}
