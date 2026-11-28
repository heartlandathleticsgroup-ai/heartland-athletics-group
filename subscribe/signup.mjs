import {TOPICS,CONSENT,CONSENT_VERSION,validateRequest} from "./consent.mjs";
export const SIGNUP_RELEASE_ENABLED=false;
export const SMS_RELEASE_ENABLED=false;
export const ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-subscriptions";
export function envelope(form,requestId,{smsEnabled=false}={}){
 if(form.sms.enabled&&!smsEnabled)throw Error("SMS is not available yet.");
 validateRequest(form);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId))throw Error("Invalid request.");
 return {action:"subscribe",requestId,version:CONSENT_VERSION,form};
}
export function createSignupClient({mode,request}){
 if(typeof request!=="function"||!(mode==="isolated"&&request!==globalThis.fetch||mode==="release"&&SIGNUP_RELEASE_ENABLED))throw Error("Signup not released");
 return async payload=>{
  const response=await request(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});
  if(response.status!==202)throw Error("Request unavailable.");
  return true;
 };
}
export function attachSignup(doc,{call=null,smsEnabled=false,randomId=()=>crypto.randomUUID()}={}){
 const $=id=>doc.getElementById(id),channels=["email","sms"];let busy=false,requestId=null;
 for(const c of channels){
  const enabled=$(c+"-enabled"),details=$(c+"-details"),topics=$(c+"-topics");
  $(c+"-wording").textContent=CONSENT[c];
  for(const [code,label] of TOPICS){const node=doc.createElement("label"),input=doc.createElement("input");input.type="checkbox";input.value=code;node.append(input," "+label);topics.append(node);}
  enabled.addEventListener("change",()=>{details.hidden=!enabled.checked;$(c+"-destination").disabled=!enabled.checked;if(!enabled.checked){$(c+"-destination").value="";$(c+"-consent").checked=false;for(const x of topics.querySelectorAll("input"))x.checked=false;}});
  $(c+"-destination").disabled=true;
 }
 $("sms-channel").disabled=!smsEnabled;
 const form=$("subscriber-form");
 form.addEventListener("input",()=>{if(!busy)requestId=null;});
 form.addEventListener("submit",async event=>{
  event.preventDefault();if(!call||busy)return;$("signup-error").textContent="";
  const choice=c=>$(c+"-enabled").checked?{enabled:true,destination:$(c+"-destination").value,topics:[...$(c+"-topics").querySelectorAll("input:checked")].map(x=>x.value),consent:$(c+"-consent").checked}:{enabled:false,destination:"",topics:[],consent:false};
  const value={name:$("subscriber-name").value,adult:$("adult").checked,email:choice("email"),sms:choice("sms")};
  let payload;try{payload=envelope(value,requestId??=randomId(),{smsEnabled});}catch(error){$("signup-error").textContent=error.message;return;}
  busy=true;$("signup-fields").disabled=true;
  try{await call(payload);form.reset();for(const c of channels){$(c+"-details").hidden=true;$(c+"-destination").disabled=true;}requestId=null;$("release-status").textContent="Request received. Eligible email subscriptions begin without a confirmation step. If eligible, one welcome email may be sent. SMS, when available, requires confirmation. Manage or withdraw your choices at any time.";}
  catch{$("signup-error").textContent="Unable to complete the request. Please try again or contact H.A.G.";}
  finally{busy=false;$("signup-fields").disabled=false;}
 });
 if(call){$("signup-fields").disabled=false;$("subscribe-submit").disabled=false;$("release-status").textContent="Choose your contact method and topics. Email and text consent are separate.";}
}
if(typeof document!=="undefined"){const call=SIGNUP_RELEASE_ENABLED?createSignupClient({mode:"release",request:globalThis.fetch.bind(globalThis)}):null;attachSignup(document,{call,smsEnabled:SMS_RELEASE_ENABLED});}
