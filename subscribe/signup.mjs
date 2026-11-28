import {TOPICS,CONSENT,CONSENT_VERSION,validateRequest} from "./consent.mjs";
export const SIGNUP_RELEASE_ENABLED=false;
export const SMS_RELEASE_ENABLED=false;
// This draft UI cannot submit until the sport-aware contract, storage and delivery gates are implemented.
export const SPORT_PREFERENCES_READY=false;
export const ENDPOINT="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-subscriptions";
export function envelope(form,requestId,{smsEnabled=false}={}){
 if(form.sms.enabled&&!smsEnabled)throw Error("SMS is not available yet.");
 validateRequest(form);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId))throw Error("Invalid request.");
 return {action:"subscribe",requestId,version:CONSENT_VERSION,form};
}
export function createSignupClient({mode,request}){
 if(typeof request!=="function"||!(mode==="isolated"&&request!==globalThis.fetch||mode==="release"&&SIGNUP_RELEASE_ENABLED&&SPORT_PREFERENCES_READY))throw Error("Signup not released");
 return async payload=>{
  const response=await request(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});
  if(response.status!==202)throw Error("Request unavailable.");
  return true;
 };
}
// Preview catalog, not the existing nine-topic backend contract. Do not serialize these IDs to the old API.
export const SPORTS=Object.freeze([
 ["basketball","Basketball"],["volleyball","Volleyball"],["baseball","Baseball"],
 ["softball","Softball"],["football","Football"],["soccer","Soccer"],
 ["all-sports","All current and future sports"]
].map(Object.freeze));
export const UPDATE_TYPES=Object.freeze([
 ["general","General H.A.G. announcements"],["enforcers","Heartland Enforcers Basketball Club"],
 ["gus-macker","Gus Macker – Quincy"],["tryouts-registration","Tryouts and registrations"],
 ["camps-clinics","Camps and clinics"],["tournaments-events","Tournaments and events"],
 ["recreational-leagues","Youth recreational leagues"],["sponsorship","Sponsorship opportunities"],
 ["volunteer","Volunteer opportunities"]
].map(Object.freeze));
export function attachSignup(doc){
 const $=id=>doc.getElementById(id);
 // No transport, storage, personal information collection or submission in this preview.
 const addOptions=(id,items)=>items.map(([code,title])=>{
  const label=doc.createElement("label"),input=doc.createElement("input");
  input.type="checkbox";input.value=code;label.append(input," "+title);$(id).append(label);return input;
 });
 const sports=addOptions("sports-options",SPORTS),all=sports.at(-1);
 for(const s of sports)s.addEventListener("change",()=>{
  if(!s.checked)return;
  if(s===all){for(const other of sports)if(other!==all)other.checked=false;}
  else all.checked=false;
 });
 addOptions("update-options",UPDATE_TYPES);
 for(const c of ["email","sms"]){
  const enabled=$(c+"-enabled"),details=$(c+"-details"),consent=$(c+"-consent");
  $(c+"-wording").textContent=CONSENT[c];
  const sync=()=>{details.hidden=!enabled.checked;$(c+"-destination").disabled=true;if(!enabled.checked)consent.checked=false;};
  enabled.addEventListener("change",sync);sync();
 }
 $("subscriber-form").addEventListener("submit",event=>event.preventDefault());
 $("subscriber-name").disabled=true;$("subscribe-submit").disabled=true;
 $("signup-fields").disabled=false;
}
if(typeof document!=="undefined")attachSignup(document);
