import {UPDATES} from "../subscribe/sport-contract.mjs";
export const SPORT_ADMIN_RELEASE_ENABLED=false;
export function attachSportAdmin(root,{allowed,api}){
 const panel=root.querySelector("[data-sport-admin]");if(!panel)return {clear(){}};
 const $=n=>panel.querySelector("[data-sport-"+n+"]"),doc=panel.ownerDocument;
 let epoch=0,busy=false,rules=[],draftId=null,draftRevision=0;
 const say=v=>{$("status").textContent=v;};
 const option=(value,text)=>{const e=doc.createElement("option");e.value=value;e.textContent=text;return e;};
 $("update").replaceChildren(...UPDATES.map(([code,label])=>option(code,label)));
 const buttons=["load","save","count","add-rule","draft-list","draft-new","draft-save","optout","review-load"].map($).filter(Boolean);
 function clear(){if($("optout-panel")){$("optout-destination").value="";$("review-list").replaceChildren();$("optout-status").textContent="Review-only controls; not released.";}epoch++;busy=false;rules=[];draftId=null;draftRevision=0;$("drafts").replaceChildren();$("draft-subject").value="";$("draft-body").value="";$("rules").replaceChildren();$("list").replaceChildren();$("target").replaceChildren(option("","Organization-wide"));$("code").value="";$("label").value="";$("active").checked=false;$("result").textContent="";say(api?"Load sports after administrator verification.":"Sport controls not released.");for(const b of buttons)b.disabled=!api;}
 clear();
 async function run(work){if(!api||!allowed()||busy)return;const ticket=epoch;busy=true;for(const b of buttons)b.disabled=true;try{await work(()=>ticket===epoch&&allowed());}catch{if(ticket===epoch&&allowed())say("Unavailable. Verify your administrator session and try again.");}finally{if(ticket===epoch){busy=false;for(const b of buttons)b.disabled=!api;}}}
 async function load(current){const rows=await api({p_action:"catalog"});if(!current())return;if(!Array.isArray(rows))throw Error("Invalid catalog");$("list").replaceChildren();$("target").replaceChildren(option("","Organization-wide"));for(const v of rows){const button=doc.createElement("button");button.type="button";button.className="secondary";button.textContent=v.label+(v.active?"":" (inactive)");button.addEventListener("click",()=>{if(!allowed())return;$("code").value=v.code;$("label").value=v.label;$("active").checked=v.active;});$("list").append(button);if(v.active)$("target").append(option(v.code,v.label));}say("Sports loaded. Categories are not public program commitments.");}
 $("load").addEventListener("click",()=>void run(load));
 $("save").addEventListener("click",()=>void run(async current=>{await api({p_action:"save",p_code:$("code").value.trim(),p_label:$("label").value.trim(),p_active:$("active").checked});if(current())await load(current);}));
 function renderRules(){const root=$("rules");root.replaceChildren();for(const [i,r] of rules.entries()){const row=doc.createElement("p"),remove=doc.createElement("button");remove.type="button";remove.textContent="Remove";remove.addEventListener("click",()=>{if(!allowed()||busy)return;rules.splice(i,1);renderRules();$("result").textContent="";});row.append((r.sport||"Organization-wide")+" — "+r.update+" ",remove);root.append(row);}}
 $("add-rule").addEventListener("click",()=>{if(!allowed()||!api||busy||rules.length>=30)return;const r={sport:$("target").value||null,update:$("update").value};if(!rules.some(x=>x.sport===r.sport&&x.update===r.update)){rules.push(r);renderRules();$("result").textContent="";}});
 $("count").addEventListener("click",()=>void run(async current=>{const v=await api({p_action:"count-union",p_targets:rules.length?[...rules]:[{sport:$("target").value||null,update:$("update").value}],p_channel:$("channel").value});if(current())$("result").textContent=Number.isSafeInteger(v?.count)?v.count+" eligible contact methods (not sent).":"Count unavailable.";}));
 function loadDraft(v){draftId=v.id;draftRevision=v.revision;$("draft-subject").value=v.subject;$("draft-body").value=v.body;$("channel").value=v.channel;rules=v.targets;renderRules();$("result").textContent="";}
 async function draftList(current){const rows=await api({p_action:"draft-list"});if(!current())return;if(!Array.isArray(rows))throw Error("Invalid drafts");$("drafts").replaceChildren();for(const v of rows){const b=doc.createElement("button");b.type="button";b.className="secondary";b.textContent=v.subject+" ("+v.channel+")";b.addEventListener("click",()=>void run(async active=>{const d=await api({p_action:"draft-read",p_id:v.id});if(active()&&d?.ok===true)loadDraft(d);}));$("drafts").append(b);}}
 $("draft-list").addEventListener("click",()=>void run(draftList));
 $("draft-new").addEventListener("click",()=>{if(!allowed()||!api||busy)return;draftId=null;draftRevision=0;$("draft-subject").value="";$("draft-body").value="";say("New draft. Select audience rules before saving.");});
 $("draft-save").addEventListener("click",()=>void run(async current=>{const id=draftId||crypto.randomUUID(),v=await api({p_action:"draft-save",p_id:id,p_revision:draftRevision,p_subject:$("draft-subject").value,p_body:$("draft-body").value,p_targets:rules.length?[...rules]:[{sport:$("target").value||null,update:$("update").value}],p_channel:$("channel").value});if(!current())return;if(v?.ok!==true){say("Draft changed elsewhere. Reload before saving.");return;}loadDraft(v);say("Private draft saved. No message was sent.");await draftList(current);}));
 if($("optout-panel")){
  const sayOpt=v=>{$("optout-status").textContent=v;};
  const loadReview=async current=>{
   const rows=await api({p_action:"sms-review-list"});if(!current())return;
   if(!Array.isArray(rows)||rows.length>50)throw Error("Unavailable");
   $("review-list").replaceChildren();
   for(const row of rows){
    if(!/^SM[a-fA-F0-9]{32}$/.test(row?.message_sid||"")||typeof row.reply_text!=="string"||row.reply_text.length>1600||!/^\+1[2-9][0-9]{9}$/.test(row.destination||""))throw Error("Unavailable");
    const box=doc.createElement("div"),from=doc.createElement("p"),body=doc.createElement("p"),done=doc.createElement("button");
    from.textContent=row.destination;body.textContent=row.reply_text;done.type="button";done.textContent="Mark reviewed (keep opted out)";
    done.addEventListener("click",()=>void run(async active=>{const r=await api({p_action:"sms-review-close",p_code:row.message_sid});if(active()&&r?.ok===true)await loadReview(active);}));
    box.append(from,body,done);$("review-list").append(box);
   }
   sayOpt(rows.length+" pending replies (up to 50). Marketing remains withdrawn.");
  };
  $("review-load").addEventListener("click",()=>void run(loadReview));
  $("optout").addEventListener("click",()=>void run(async current=>{
   const channel=$("optout-channel").value,destination=$("optout-destination").value.trim();
   if(!["email","sms"].includes(channel)||!destination||!globalThis.confirm("Record withdrawal of all marketing on this channel?"))return;
   const result=await api({p_action:"optout-"+channel,p_code:destination});
   if(current()){if(result?.ok!==true){sayOpt("Opt-out unavailable. Verify the address or number.");return;}$("optout-destination").value="";sayOpt(result.matched===false?"No existing email subscription matched.":"Opt-out recorded. No message sent.");}
  }));
 }
 return {clear};
}
