// Presentation only: no credentials, data queries, storage or authorization decisions.
export const MODULES=Object.freeze(["overview","website","events","sponsors","enforcers","inquiries","mobile","security"]);
export function selectModule(root,id){
 if(!MODULES.includes(id)||!root||root.hidden)return false;
 const buttons=Array.from(root.querySelectorAll("[data-module]"));
 const panels=Array.from(root.querySelectorAll("[data-module-panel]"));
 if(!buttons.some(b=>b.dataset.module===id)||!panels.some(p=>p.dataset.modulePanel===id))return false;
 for(const b of buttons)b.setAttribute("aria-pressed",String(b.dataset.module===id));
 for(const p of panels)p.hidden=p.dataset.modulePanel!==id;
 return true;
}
export function attachDashboard(root){
 if(!root)return;
 root.querySelectorAll("[data-module]").forEach(button=>button.addEventListener("click",()=>selectModule(root,button.dataset.module)));
 // Reset navigation after sign-out/lock, but never reveal the authorization container.
 if(typeof MutationObserver==="function"){
  let wasHidden=root.hidden;
  new MutationObserver(()=>{const hidden=root.hidden;if(wasHidden&&!hidden)selectModule(root,"overview");wasHidden=hidden;}).observe(root,{attributes:true,attributeFilter:["hidden"]});
 }
}
if(typeof document!=="undefined")attachDashboard(document.getElementById("authorized-panel"));
