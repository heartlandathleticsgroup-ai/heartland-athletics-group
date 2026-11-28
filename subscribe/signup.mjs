import {TOPICS,CONSENT,CONSENT_VERSION,validateRequest} from "./consent.mjs";
import {SPORTS as BASE_SPORTS,UPDATES,VERSION,SPORT_CONSENT_SUFFIX,selectionPayload} from "./sport-contract.mjs";
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
export const SPORTS=Object.freeze([...BASE_SPORTS,Object.freeze(["all-sports","All current and future sports"])]);
export const UPDATE_TYPES=Object.freeze(UPDATES.map(([code,label])=>Object.freeze([code,label])));
export function createSportClient({mode,request}){
 if(typeof request!=="function"||!(mode==="isolated"&&request!==globalThis.fetch||mode==="release"&&SIGNUP_RELEASE_ENABLED&&SPORT_PREFERENCES_READY))throw Error("Sport signup not released");
 return async payload=>{
 const r=await request(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});
 if(payload.action==="sport-catalog"){if(r.status!==200)throw Error("Catalog unavailable");return (await r.json()).catalog;}
 if(r.status!==202)throw Error("Request unavailable");return true;
 };
}
export function sportEnvelope(form,requestId,catalog,{smsEnabled=false}={}){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)||form.sms.enabled&&!smsEnabled)throw Error("Channel unavailable.");
 return {action:"sport-subscribe",requestId,version:VERSION,form:selectionPayload(form,catalog)};
}
export function attachSignup(doc,{call=null,catalog=BASE_SPORTS,smsEnabled=false,randomId=()=>crypto.randomUUID()}={}){
 const $=id=>doc.getElementById(id),live=typeof call==="function";
 const sportList=[...catalog,["all-sports","All current and future sports"]];
 const addOptions=(root,items)=>items.map(([code,title])=>{
  const label=doc.createElement("label"),input=doc.createElement("input");input.type="checkbox";input.value=code;label.append(input," "+title);root.append(label);return input;
 });
 const exclusivity=inputs=>{const all=inputs.at(-1);for(const s of inputs)s.addEventListener("change",()=>{if(!s.checked)return;if(s===all){for(const other of inputs)if(other!==all)other.checked=false;}else all.checked=false;});};
 const selected=controls=>controls.filter(x=>x.checked).map(x=>x.value);
 const sports=addOptions($("sports-options"),sportList),updates=addOptions($("update-options"),UPDATE_TYPES);exclusivity(sports);
 const overrides={};let requestId=null,busy=false;
 for(const c of ["email","sms"]){
  const enabled=$(c+"-enabled"),details=$(c+"-details"),consent=$(c+"-consent"),custom=$(c+"-customize"),root=$(c+"-custom-options");
  $(c+"-wording").textContent=CONSENT[c]+SPORT_CONSENT_SUFFIX;
  const sportRoot=doc.createElement("div"),updateRoot=doc.createElement("div"),toggle=doc.createElement("input"),label=doc.createElement("label");toggle.type="checkbox";label.append(toggle," Use different preferences for this channel");root.append(label,sportRoot,updateRoot);
  const sp=addOptions(sportRoot,sportList),up=addOptions(updateRoot,UPDATE_TYPES);exclusivity(sp);sportRoot.hidden=true;updateRoot.hidden=true;
  toggle.addEventListener("change",()=>{sportRoot.hidden=updateRoot.hidden=!toggle.checked;if(toggle.checked){for(const s of sp)s.checked=selected(sports).includes(s.value);for(const u of up)u.checked=selected(updates).includes(u.value);}consent.checked=false;});
  overrides[c]={toggle,sp,up};
  const sync=()=>{details.hidden=!enabled.checked;$(c+"-destination").disabled=!live||!enabled.checked;if(!enabled.checked){$(c+"-destination").value="";consent.checked=false;toggle.checked=false;sportRoot.hidden=updateRoot.hidden=true;}};
  enabled.addEventListener("change",sync);sync();custom.hidden=false;
 }
 if(live&&!smsEnabled)$("sms-channel").disabled=true;
 const form=$("subscriber-form");
 form.addEventListener("input",()=>{if(!busy)requestId=null;});
 form.addEventListener("submit",async event=>{
  event.preventDefault();if(!live||busy)return;
  const choice=c=>{const o=overrides[c];return {enabled:$(c+"-enabled").checked,destination:$(c+"-destination").value,sports:selected(o.toggle.checked?o.sp:sports),updates:selected(o.toggle.checked?o.up:updates),consent:$(c+"-consent").checked};};
  let payload;try{payload=sportEnvelope({name:$("subscriber-name").value,adult:$("adult").checked,email:choice("email"),sms:choice("sms")},requestId??=randomId(),catalog.map(x=>x[0]),{smsEnabled});}catch(e){$("signup-error").textContent=e.message;return;}
  busy=true;$("signup-fields").disabled=true;$("signup-error").textContent="";
  try{await call(payload);form.reset();for(const c of ["email","sms"]){$(c+"-details").hidden=true;$(c+"-destination").disabled=true;}requestId=null;$("release-status").textContent="Request received. Eligible email subscriptions begin without a confirmation step. A welcome acknowledgment may be sent with preference and unsubscribe links.";}
  catch{$("signup-error").textContent="Unable to complete the request. Please try again or contact H.A.G.";}
  finally{busy=false;$("signup-fields").disabled=false;}
 });
 $("subscriber-name").disabled=!live;$("subscribe-submit").disabled=!live;$("signup-fields").disabled=false;
 if(live){$("subscriber-name").autocomplete="name";$("email-destination").autocomplete="email";$("sms-destination").autocomplete="tel";$("release-status").textContent="Choose your sports and update types. Consent is separate for each communication method.";}
}
if(typeof document!=="undefined"){
 if(SIGNUP_RELEASE_ENABLED&&SPORT_PREFERENCES_READY){
  const call=createSportClient({mode:"release",request:globalThis.fetch.bind(globalThis)});
  call({action:"sport-catalog"}).then(rows=>{if(!Array.isArray(rows)||rows.length>40||rows.some(v=>typeof v.code!=="string"||typeof v.label!=="string"))throw Error("Invalid catalog");attachSignup(document,{call,catalog:rows.map(v=>[v.code,v.label]),smsEnabled:SMS_RELEASE_ENABLED});}).catch(()=>{document.getElementById("release-status").textContent="Subscriptions are currently unavailable.";});
 }else attachSignup(document);
}
