import {TOPICS,CONSENT_VERSION,normalizeDestination} from "./consent.mjs";
export const PREFERENCE_RELEASE_ENABLED=false;
export const ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-subscriptions";
const token=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
export function parseFragment(fragment){
 const m=typeof fragment==="string"&&fragment.match(/^#(manage|unsubscribe):([a-f0-9]{64})$/);
 return m?{purpose:m[1],token:m[2]}:null;
}
export function createPreferenceClient({mode,request}){
 if(typeof request!=="function"||!(mode==="isolated"&&request!==globalThis.fetch||mode==="release"&&PREFERENCE_RELEASE_ENABLED))throw Error("Preferences not released");
 return async payload=>{
  const target=ENDPOINT+(payload.action==="unsubscribe"?"/unsubscribe":"");
  const r=await request(target,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});
  if(!r.ok)throw Error("Request unavailable");
  return r.json();
 };
}
export function attachPreferences(doc,{call,link,randomId=()=>crypto.randomUUID()}){
 const $=id=>doc.getElementById(id);
 let busy=false,editToken=null,baseline=new Map(),controls=[];
 const say=(text,error=false)=>{$(error?"error":"status").textContent=text;};
 const run=async fn=>{if(busy)return;busy=true;$("error").textContent="";for(const b of doc.querySelectorAll("button"))b.disabled=true;try{await fn();}catch{say("Unable to complete this request. Try again or contact info@heartlandathleticsgroup.com.",true);}finally{busy=false;for(const b of doc.querySelectorAll("button"))b.disabled=false;}};
 const additions=()=>controls.filter(x=>x.checked&&baseline.get(x.value)!=="active").map(x=>x.value);
 const removals=()=>controls.filter(x=>!x.checked&&["active","pending"].includes(baseline.get(x.value))).map(x=>x.value);
 function updateConsent(){$("new-consent").hidden=additions().length===0;if($("new-consent").hidden){$("adult").checked=false;$("consent").checked=false;}}
 $("request").hidden=false;
 const access=purpose=>run(async()=>{const destination=normalizeDestination("email",$("email").value);await call({action:"access",requestId:randomId(),purpose,form:{channel:"email",destination}});$("email").value="";say("If eligible, a secure link can be sent to that email address.");});
 $("manage-link").addEventListener("click",()=>void access("manage"));$("unsubscribe-link").addEventListener("click",()=>void access("unsubscribe"));
 if(link){
  $("redeem").hidden=false;$("redeem-heading").textContent=link.purpose==="unsubscribe"?"Stop marketing email":"Review email preferences";$("redeem-detail").textContent=link.purpose==="unsubscribe"?"Select Unsubscribe to stop all H.A.G. marketing email. Your SMS choices are not affected.":"Select Continue to securely view your existing email choices.";$("redeem-button").textContent=link.purpose==="unsubscribe"?"Unsubscribe":"Continue";
  $("redeem-button").addEventListener("click",()=>void run(async()=>{
   if(!link)return;const r=await call({action:link.purpose,token:link.token});const purpose=link.purpose;link=null;$("redeem").hidden=true;
   if(r?.ok!==true){say("This link is invalid, expired or already used. Request a new link.",true);return;}
   if(purpose==="unsubscribe"){say("Unsubscribe completed.");return;}
   if(r.channel!=="email"||!token(r.editToken)||typeof r.suppressed!=="boolean"||!Array.isArray(r.preferences)||r.preferences.length>9||r.preferences.some(v=>!TOPICS.some(t=>t[0]===v.topic)||!["active","pending","withdrawn"].includes(v.status)))throw Error("Invalid preferences");
   editToken=r.editToken;baseline=new Map(r.preferences.map(v=>[v.topic,v.status]));controls=[];$("topics").replaceChildren();
   for(const [code,title] of TOPICS){const label=doc.createElement("label"),input=doc.createElement("input");input.type="checkbox";input.value=code;input.checked=["active","pending"].includes(baseline.get(code));input.addEventListener("change",updateConsent);label.append(input,title);$("topics").append(label);controls.push(input);}
   $("suppressed").textContent=r.suppressed?"This address is suppressed. Additions cannot override a suppression; contact us for help.":"Select or remove topics below.";$("edit").hidden=false;$("edit-heading").focus();updateConsent();say("Email preferences verified.");
  }));
 }
 $("save").addEventListener("click",()=>void run(async()=>{
  if(!editToken)return;const add=additions(),remove=removals();if(!add.length&&!remove.length){say("No changes selected.");return;}if(add.length&&(!$("adult").checked||!$("consent").checked)){say("Confirm adult status and consent for new topics.",true);return;}
  const t=editToken;editToken=null;const r=await call({action:"edit",token:t,add,remove,adult:$("adult").checked,consent:$("consent").checked,version:CONSENT_VERSION});
  $("edit").hidden=true;$("topics").replaceChildren();controls=[];baseline.clear();$("adult").checked=false;$("consent").checked=false;
  say(r?.ok===true?"Preferences saved.":"Unable to save. Request a new secure link.",r?.ok!==true);
 }));
}
if(typeof document!=="undefined"){
 const link=parseFragment(location.hash);
 // Strip capability from the address bar before any API call or user interaction.
 if(location.hash)history.replaceState(null,"",location.pathname+location.search);
 if(PREFERENCE_RELEASE_ENABLED){const call=createPreferenceClient({mode:"release",request:globalThis.fetch.bind(globalThis)});attachPreferences(document,{call,link});}
}
