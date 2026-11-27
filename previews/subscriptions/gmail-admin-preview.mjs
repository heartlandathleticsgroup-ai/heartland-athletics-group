// Offline admin preview. No network, storage, OAuth redirect or production credentials.
const $=id=>document.getElementById(id);
let status={connected:true,enabled:true},holds=[{job_id:"00000000-0000-4000-8000-000000000001",created_at:"Synthetic example",started:true}],busy=false;
const api=async(action,data)=>{
 if(action==="status")return {...status};
 if(action==="review")return {holds:holds.map(x=>({...x}))};
 if(action==="disable"){status.enabled=false;return {enabled:false};}
 if(action==="disconnect"){status={connected:false,enabled:false};return {connected:false,enabled:false,providerRevoked:false};}
 if(action==="rotate"){if(status.enabled||!status.connected)throw Error("Disable first");return {ok:true,enabled:false};}
 if(action==="review-close"){holds=holds.filter(x=>x.job_id!==data.job);return {ok:true};}
 throw Error("Unsupported action");
};
async function render(){
 const s=await api("status");const list=await api("review");
 $("status").textContent=(s.connected?"Connected (simulated)":"Disconnected")+" · "+(s.enabled?"Enabled (simulated)":"Disabled");
 $("disable").disabled=busy||!s.enabled;$("disconnect").disabled=busy||!s.connected;$("rotate").disabled=busy||s.enabled||!s.connected;$("refresh").disabled=busy;
 $("holds").replaceChildren();
 if(!list.holds.length){$("holds").textContent="No unresolved dispatches.";return;}
 for(const row of list.holds){
  const p=document.createElement("p");p.textContent="Job "+row.job_id.slice(-8)+" — "+(row.started?"Dispatch started; outcome uncertain":"Reserved; outcome uncertain");
  const label=document.createElement("label"),select=document.createElement("select");select.setAttribute("aria-label","Review disposition for job "+row.job_id.slice(-8));
  for(const [value,text] of [["closed-unverified-no-resend","Close — outcome unverified"],["provider-acceptance-observed-no-resend","Close — acceptance observed"]]){const o=document.createElement("option");o.value=value;o.textContent=text;select.append(o);}
  label.append("Disposition ",select);
  const b=document.createElement("button");b.type="button";b.textContent="Close without resend";b.disabled=busy;b.addEventListener("click",()=>void run("review-close",{job:row.job_id,disposition:select.value}));
  $("holds").append(p,label,b);
 }
}
async function run(action,data){if(busy)return;busy=true;$("error").textContent="";await render();try{if(action!=="refresh")await api(action,data);}catch{$("error").textContent="Action could not be completed.";}finally{busy=false;await render();}}
for(const id of ["refresh","disable","disconnect","rotate"])$(id).addEventListener("click",()=>void run(id));
void render();
