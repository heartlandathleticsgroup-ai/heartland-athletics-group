import {TOPICS,CONSENT,CONSENT_VERSION,validateRequest} from "./consent.mjs";
export const SIGNUP_RELEASE_ENABLED=false;
export const SMS_RELEASE_ENABLED=false;
export const ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-subscriptions";
const blank=()=>({enabled:false,destination:"",topics:[],consent:false});
export function makeChannelSignup({name,adult,email,sms},requestId){
 const form={name,adult,email:email||blank(),sms:sms||blank()};validateRequest(form);
 return {action:"subscribe",requestId,version:CONSENT_VERSION,form};
}
export function makeSignup({name,adult,email,topics,consent},requestId){
 return makeChannelSignup({name,adult,email:{enabled:true,destination:email,topics,consent}},requestId);
}
export function attachSignup(doc,call,{smsPreview=false}={}){
 // smsPreview is only for isolated fixture rendering; sendSignup independently blocks SMS.
 const $=id=>doc.getElementById(id),form=$("signup"),detail=$("details"),adult=$("adult"),result=$("result");let busy=false,requestId=null;
 const channels=["email","sms"],canChoose=k=>k==="email"||smsPreview;
 for(const k of channels){
  $(k+"-wording").textContent=CONSENT[k];
  for(const [code,title] of TOPICS){const l=doc.createElement("label"),i=doc.createElement("input");i.type="checkbox";i.value=code;i.disabled=true;l.append(i,doc.createTextNode(title));$(k+"-topics").append(l);}
 }
 $("sms-section").disabled=!smsPreview;
 if(smsPreview){$("sms-heading").textContent="Text updates (isolated preview)";$("sms-availability").textContent="Confirm your mobile number before text updates begin.";}
 function resetChannel(k){const enabled=canChoose(k)&&$(k+"-enabled").checked,fields=$(k+"-fields");fields.hidden=!enabled;for(const x of fields.querySelectorAll("input")){x.disabled=!enabled;if(!enabled){if(x.type==="checkbox")x.checked=false;else x.value="";}}}
 function resetDetails(){detail.disabled=!adult.checked;detail.hidden=!adult.checked;if(!adult.checked){$("name").value="";for(const k of channels)$(k+"-enabled").checked=false;}for(const k of channels)resetChannel(k);}
 const choice=k=>canChoose(k)&&$(k+"-enabled").checked?{enabled:true,destination:$(k==="email"?"email":"phone").value,topics:[...$(k+"-topics").querySelectorAll("input:checked")].map(i=>i.value),consent:$(k+"-consent").checked}:blank();
 adult.addEventListener("change",resetDetails);for(const k of channels)$(k+"-enabled").addEventListener("change",()=>resetChannel(k));form.addEventListener("input",()=>{requestId=null;});
 form.addEventListener("submit",async e=>{e.preventDefault();if(busy)return;try{const payload=makeChannelSignup({name:$("name").value,adult:adult.checked,email:choice("email"),sms:choice("sms")},requestId||(requestId=crypto.randomUUID()));busy=true;detail.disabled=true;adult.disabled=true;await call(payload);form.reset();requestId=null;resetDetails();result.textContent="Request received. If eligible, your email selections take effect and a welcome acknowledgment may be sent. Text selections require mobile confirmation.";}catch(e){result.textContent=busy?"Unable to complete the request. Try again later or contact us.":e.message;}finally{busy=false;adult.disabled=false;detail.disabled=!adult.checked;}});
 resetDetails();form.hidden=false;$("availability").textContent=smsPreview?"Isolated preview — no real delivery.":"Email updates are available. Text updates are not available yet.";
}
export async function sendSignup(payload){if(!SIGNUP_RELEASE_ENABLED||payload?.form?.sms?.enabled!==false)throw Error("Signup unavailable");const r=await fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal:AbortSignal.timeout(10000)});if(r.status!==202)throw Error("Unavailable");}
if(typeof document!=="undefined"&&SIGNUP_RELEASE_ENABLED)attachSignup(document,sendSignup);
