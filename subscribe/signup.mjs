import {TOPICS,CONSENT,CONSENT_VERSION,validateRequest} from "./consent.mjs";
export const SIGNUP_RELEASE_ENABLED=false;
export const ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-subscriptions";
const blank=()=>({enabled:false,destination:"",topics:[],consent:false});
export function makeSignup({name,adult,email,topics,consent},requestId){
 const form={name,adult,email:{enabled:true,destination:email,topics,consent},sms:blank()};
 validateRequest(form);
 return {action:"subscribe",requestId,version:CONSENT_VERSION,form};
}
export function attachSignup(doc,call){
 const $=id=>doc.getElementById(id),form=$("signup"),detail=$("details"),adult=$("adult"),enabled=$("email-enabled"),fields=$("email-fields"),result=$("result");let busy=false,requestId=null;
 $("email-wording").textContent=CONSENT.email;$("sms-wording").textContent=CONSENT.sms;
 for(const [code,title] of TOPICS){const l=doc.createElement("label"),i=doc.createElement("input");i.type="checkbox";i.value=code;l.append(i,doc.createTextNode(title));$("email-topics").append(l);}
 function resetDetails(){detail.disabled=!adult.checked;detail.hidden=!adult.checked;if(!adult.checked){$("name").value="";enabled.checked=false;resetEmail();}}
 function resetEmail(){fields.hidden=!enabled.checked;for(const x of fields.querySelectorAll("input")){x.disabled=!enabled.checked;if(!enabled.checked){if(x.type==="checkbox")x.checked=false;else x.value="";}}}
 adult.addEventListener("change",resetDetails);enabled.addEventListener("change",resetEmail);form.addEventListener("input",()=>{requestId=null;});
 form.addEventListener("submit",async e=>{e.preventDefault();if(busy)return;try{if(!enabled.checked)throw Error("Choose email updates.");const payload=makeSignup({name:$("name").value,adult:adult.checked,email:$("email").value,topics:[...$("email-topics").querySelectorAll("input:checked")].map(i=>i.value),consent:$("email-consent").checked},requestId||(requestId=crypto.randomUUID()));busy=true;detail.disabled=true;adult.disabled=true;await call(payload);form.reset();requestId=null;resetDetails();result.textContent="Request received. If eligible, your email selections take effect and a welcome acknowledgment may be sent. No activation link is needed.";}catch(e){result.textContent=busy?"Unable to complete the request. Try again later or contact us.":e.message;}finally{busy=false;adult.disabled=false;detail.disabled=!adult.checked;}});
 resetDetails();form.hidden=false;$("availability").textContent="Email updates are available. Text updates are not available yet.";
}
export async function sendSignup(payload){if(!SIGNUP_RELEASE_ENABLED)throw Error("Signup unavailable");const r=await fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",signal:AbortSignal.timeout(10000)});if(r.status!==202)throw Error("Unavailable");}
if(typeof document!=="undefined"&&SIGNUP_RELEASE_ENABLED)attachSignup(document,sendSignup);
