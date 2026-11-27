import {TOPICS,CONSENT,validateRequest,validatePreferenceAccess} from "./consent.mjs";
const $=id=>document.getElementById(id);
for(const channel of ["email","sms"]){
 const enabled=$(channel+"-enabled"),details=$(channel+"-details"),destination=$(channel+"-destination"),consent=$(channel+"-consent"),topics=$(channel+"-topics");
 $(channel+"-wording").textContent=CONSENT[channel];
 for(const [code,label] of TOPICS){
  const l=document.createElement("label"),cb=document.createElement("input");l.className="check";cb.type="checkbox";cb.value=code;cb.disabled=true;l.append(cb,document.createTextNode(label));topics.append(l);
 }
 function sync(){
  details.hidden=!enabled.checked;
  destination.disabled=consent.disabled=!enabled.checked;
  for(const cb of topics.querySelectorAll("input")){cb.disabled=!enabled.checked;if(!enabled.checked)cb.checked=false;}
  if(!enabled.checked){destination.value="";consent.checked=false;}
 }
 enabled.addEventListener("change",sync);sync();
}
function selection(channel){return {enabled:$(channel+"-enabled").checked,destination:$(channel+"-destination").value,topics:[...$(channel+"-topics").querySelectorAll("input:checked")].map(x=>x.value),consent:$(channel+"-consent").checked};}
$("optin").addEventListener("submit",event=>{
 event.preventDefault();
 try{
  const request=validateRequest({name:$("name").value,adult:$("adult").checked,email:selection("email"),sms:selection("sms")});
  $("result").textContent="Validation passed for "+request.requests.map(r=>r.channel.toUpperCase()).join(" and ")+". Preview only; nothing saved, confirmed or sent.";
  $("optin").reset();for(const c of ["email","sms"])$(c+"-enabled").dispatchEvent(new Event("change"));
 }catch(error){$("result").textContent=error.message;}
});
$("preferences").addEventListener("submit",event=>{
 event.preventDefault();
 try{validatePreferenceAccess({channel:$("access-channel").value,destination:$("access-destination").value});$("access-result").textContent="Validation passed. In production, a verified request would be required. No lookup, change or message occurred.";$("preferences").reset();}
 catch(error){$("access-result").textContent=error.message;}
});
$("validate").disabled=false;$("access-check").disabled=false;
