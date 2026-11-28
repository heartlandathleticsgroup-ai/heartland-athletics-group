import {UPDATES} from "../subscribe/sport-contract.mjs";
export const SPORT_ADMIN_RELEASE_ENABLED=false;
export function attachSportAdmin(root,{allowed,api}){
 const panel=root.querySelector("[data-sport-admin]");if(!panel)return {clear(){}};
 const $=n=>panel.querySelector("[data-sport-"+n+"]"),doc=panel.ownerDocument;
 let epoch=0,busy=false;
 const say=v=>{$("status").textContent=v;};
 const option=(value,text)=>{const e=doc.createElement("option");e.value=value;e.textContent=text;return e;};
 $("update").replaceChildren(...UPDATES.map(([code,label])=>option(code,label)));
 const buttons=["load","save","count"].map($);
 function clear(){epoch++;busy=false;$("list").replaceChildren();$("target").replaceChildren(option("","Organization-wide"));$("code").value="";$("label").value="";$("active").checked=false;$("result").textContent="";say(api?"Load sports after administrator verification.":"Sport controls not released.");for(const b of buttons)b.disabled=!api;}
 clear();
 async function run(work){if(!api||!allowed()||busy)return;const ticket=epoch;busy=true;for(const b of buttons)b.disabled=true;try{await work(()=>ticket===epoch&&allowed());}catch{if(ticket===epoch&&allowed())say("Unavailable. Verify your administrator session and try again.");}finally{if(ticket===epoch){busy=false;for(const b of buttons)b.disabled=!api;}}}
 async function load(current){const rows=await api({p_action:"catalog"});if(!current())return;if(!Array.isArray(rows))throw Error("Invalid catalog");$("list").replaceChildren();$("target").replaceChildren(option("","Organization-wide"));for(const v of rows){const button=doc.createElement("button");button.type="button";button.className="secondary";button.textContent=v.label+(v.active?"":" (inactive)");button.addEventListener("click",()=>{if(!allowed())return;$("code").value=v.code;$("label").value=v.label;$("active").checked=v.active;});$("list").append(button);if(v.active)$("target").append(option(v.code,v.label));}say("Sports loaded. Categories are not public program commitments.");}
 $("load").addEventListener("click",()=>void run(load));
 $("save").addEventListener("click",()=>void run(async current=>{await api({p_action:"save",p_code:$("code").value.trim(),p_label:$("label").value.trim(),p_active:$("active").checked});if(current())await load(current);}));
 $("count").addEventListener("click",()=>void run(async current=>{const v=await api({p_action:"count",p_code:$("target").value||null,p_update:$("update").value,p_channel:$("channel").value});if(current())$("result").textContent=Number.isSafeInteger(v?.count)?v.count+" eligible contact methods (not sent).":"Count unavailable.";}));
 return {clear};
}
