import {TOPICS,CONSENT,CONSENT_VERSION} from "./consent.mjs";
import {createPreferenceSimulation} from "./simulation.mjs";
const $=id=>document.getElementById(id);
let sim=createPreferenceSimulation(),busy=false,selected=null,verified=null,links=[];
const status=t=>{$("status").textContent=t;$("error").textContent="";};
const error=t=>{$("error").textContent=t;$("status").textContent="Request not completed.";};
const dest=c=>c==="email"?"fixture@example.invalid":"+12025550123";
const off=()=>({enabled:false,destination:"",topics:[],consent:false});
function topic(container,code,label,note,checked=false,disabled=false){
 const row=document.createElement("div");row.className="center-topic";
 const l=document.createElement("label");l.className="check";const cb=document.createElement("input");cb.type="checkbox";cb.value=code;cb.checked=checked;cb.disabled=disabled;
 const span=document.createElement("span");span.textContent=label;
 if(note){const n=document.createElement("span");n.className="topic-note";n.textContent=note;span.append(n);}
 l.append(cb,span);row.append(l);container.append(row);return cb;
}
const buttons=["start-submit","access","optout-link","expire","reset","save","close"];
function clearVerified(){verified=null;$("manage-panel").hidden=true;$("edit-topics").replaceChildren();$("edit-adult").checked=false;$("edit-agree").checked=false;$("edit-consent").hidden=true;$("edit-wording").textContent="";$("manage-detail").textContent="";}
function clearAction(){selected=null;$("action-panel").hidden=true;$("action-controls").replaceChildren();$("action-heading").textContent="";$("action-detail").textContent="";}
function setBusy(v){busy=v;for(const id of buttons)$(id).disabled=v;for(const b of document.querySelectorAll("#inbox button,#action-controls button"))b.disabled=v;}
async function run(fn){if(busy)return;setBusy(true);try{await fn();}catch{clearAction();clearVerified();error("The test request could not be completed. Try again or request a new link.");}finally{setBusy(false);}}
function resetChoices(){for(const cb of $("start-topics").querySelectorAll("input"))cb.checked=false;$("adult").checked=false;$("consent").checked=false;$("wording").textContent=CONSENT[$("channel").value];}
for(const [code,label] of TOPICS)topic($("start-topics"),code,label);
$("channel").addEventListener("change",()=>{resetChoices();clearVerified();clearAction();});
resetChoices();
function renderInbox(){
 $("inbox").replaceChildren();
 for(const item of links){
  const b=document.createElement("button");b.type="button";b.className="inbox-button";b.textContent=(item.channel==="email"?"Email":"SMS")+" — "+({confirm:"Confirm subscription",manage:"Manage preferences",unsubscribe:"Unsubscribe"}[item.purpose]);b.disabled=busy;
  b.addEventListener("click",()=>{if(!busy)open(item);});$("inbox").append(b);
 }
}
function collect(){links.push(...sim.takeMessages());if(links.length>30)links=links.slice(-30);renderInbox();}
function issueResult(r){
 if(r.status!==202){error(r.status===429?"Too many test requests. Try again later.":"Check the selected topics and consent, then try again.");return;}
 collect();status("If eligible, a test link is available in the simulated inbox. No real message was sent.");
}
$("start").addEventListener("submit",ev=>{ev.preventDefault();void run(async()=>{
 clearVerified();clearAction();const c=$("channel").value,topics=[...$("start-topics").querySelectorAll("input:checked")].map(x=>x.value);
 const choice={enabled:true,destination:dest(c),topics,consent:$("consent").checked};
 const form={name:"Synthetic fixture",adult:$("adult").checked,email:c==="email"?choice:off(),sms:c==="sms"?choice:off()};
 if(!topics.length){error("Choose at least one topic.");return;}
 issueResult(await sim.subscribe(form));resetChoices();
});});
for(const [id,purpose] of [["access","manage"],["optout-link","unsubscribe"]])$(id).addEventListener("click",()=>void run(async()=>{clearVerified();clearAction();const channel=$("channel").value;issueResult(await sim.access({channel,destination:dest(channel)},purpose));}));
function open(item){
 clearVerified();clearAction();selected=item;
 const c=item.channel==="email"?"email":"SMS";
 $("action-heading").textContent=({confirm:"Confirm subscription",manage:"Verify preference access",unsubscribe:"Unsubscribe from all "+c+" marketing"}[item.purpose]);
 $("action-detail").textContent=({confirm:"Confirm only the topics requested on this "+c+" link.",manage:"Verify this "+c+" link before viewing or changing preferences.",unsubscribe:"This withdraws all pending and active topics for this "+c+" destination only. Your other communication channel is unaffected."}[item.purpose]);
 const b=document.createElement("button");b.type="button";b.textContent=item.purpose==="unsubscribe"?"Unsubscribe from all "+c:"Continue verification";if(item.purpose==="unsubscribe")b.className="danger";
 b.addEventListener("click",()=>void run(async()=>{
  const current=selected;if(!current)return;
  const r=await sim.call({action:current.purpose,token:current.token});
  clearAction();
  if(r.status!==200){error(r.status===429?"Too many test requests. Try again later.":"Service unavailable. Request a new test link if necessary.");return;}
  if(!r.body.ok){error("This link is invalid, expired, already used or no longer eligible. Request a new test link.");return;}
  if(current.purpose==="manage"){showVerified(r.body);status("Test contact method verified.");}
  else{status(current.purpose==="confirm"?"Test subscription confirmed for the selected topics.":"Test unsubscribe completed for this channel.");$("inbox-heading").setAttribute("tabindex","-1");$("inbox-heading").focus();}
 }));
 const cancel=document.createElement("button");cancel.type="button";cancel.textContent="Cancel";cancel.addEventListener("click",()=>{clearAction();$("inbox-heading").setAttribute("tabindex","-1");$("inbox-heading").focus();});
 $("action-controls").append(b,cancel);$("action-panel").hidden=false;$("action-heading").focus();
}
function showVerified(data){
 clearVerified();
 verified={channel:data.channel,token:data.editToken,states:new Map(data.preferences.map(p=>[p.topic,p.status])),suppressed:data.suppressed};
 $("manage-detail").textContent="Verified "+(verified.channel==="email"?"email":"SMS")+" only. "+(verified.suppressed?"This channel is suppressed. New subscriptions cannot be added.":"Pending topics remain pending until their confirmation link is redeemed. Uncheck to withdraw.");
 $("edit-wording").textContent=CONSENT[verified.channel];
 for(const [code,label] of TOPICS){
  const state=verified.states.get(code)||"not subscribed";const cb=topic($("edit-topics"),code,label,state,state==="active"||state==="pending",verified.suppressed&&state!=="active"&&state!=="pending");
  // Pending starts selected but is not active. Uncheck to withdraw; confirm via its original link.
  if(state==="pending")cb.dataset.pending="true";
  cb.addEventListener("change",()=>{cb.indeterminate=false;cb.dataset.touched="true";updateEditConsent();});
 }
 $("manage-panel").hidden=false;$("manage-heading").focus();updateEditConsent();
}
function changes(){
 const add=[],remove=[];
 if(!verified)return {add,remove};
 for(const cb of $("edit-topics").querySelectorAll("input")){
  const state=verified.states.get(cb.value);
  if(cb.checked&&state!=="active"&&state!=="pending")add.push(cb.value);
  if(!cb.checked&&(state==="active"||state==="pending"))remove.push(cb.value);
 }
 return {add,remove};
}
function updateEditConsent(){const {add}=changes();$("edit-consent").hidden=!add.length;if(!add.length){$("edit-adult").checked=false;$("edit-agree").checked=false;}}
$("edit").addEventListener("submit",ev=>{ev.preventDefault();void run(async()=>{
 if(!verified)return;
 const {add,remove}=changes();
 if(!add.length&&!remove.length){error("Select a change before saving.");return;}
 if(add.length&&(!$("edit-adult").checked||!$("edit-agree").checked)){error("Confirm adult eligibility and consent for newly selected topics.");return;}
 const r=await sim.call({action:"edit",token:verified.token,add,remove,adult:$("edit-adult").checked,consent:$("edit-agree").checked,version:CONSENT_VERSION});
 clearVerified();if(r.status===200&&r.body.ok){status("Test preferences saved. Request a new verified link to review them.");$("access").focus();}else error("The change could not be saved. The link may have expired, been used or be ineligible. Request a new test link.");
});});
$("close").addEventListener("click",()=>{clearVerified();$("access").focus();});
$("expire").addEventListener("click",()=>{sim.expireLinks();clearVerified();clearAction();status("Test time advanced. Previously issued links are expired; request a new link.");});
$("reset").addEventListener("click",()=>{sim=createPreferenceSimulation();links=[];clearVerified();clearAction();resetChoices();renderInbox();status("Simulation reset. All fictional records discarded.");});
setBusy(false);
