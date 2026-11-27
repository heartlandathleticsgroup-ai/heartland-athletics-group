// Read-only presentation. Data never persisted or inserted as HTML.
export const VIEWS=Object.freeze({"contacts":[["display_name","Name"],["channel","Contact method"],["destination","Email / phone"],["adult_confirmed","Adult confirmed"],["verified_at","Method verified"],["created_at","Contact created"]],"inquiries":[["contact_name","Name"],["contact_email","Email"],["contact_phone","Phone"],["topic","Inquiry category"],["message","Message"],["status","Status"],["source","Source"],["created_at","Received"]],"subscribers":[["display_name","Name"],["destination","Email / phone"],["channel","Channel"],["topic","Preference"],["status","Opt-in status"],["has_confirmation","Confirmation recorded"],["suppressed","Suppression active"],["created_at","Created"]],"preferences":[["label","Topic"],["code","Topic code"],["active","Topic enabled"],["email_active","Active unsuppressed email opt-ins"],["sms_active","Active unsuppressed SMS opt-ins"]],"consent":[["display_name","Name"],["destination","Email / phone"],["channel","Channel"],["topic","Topic"],["event_kind","Consent event"],["consent_version","Consent version"],["consent_text","Consent wording"],["source","Source"],["occurred_at","Recorded"]],"suppressions":[["display_name","Name"],["destination","Email / phone"],["channel","Channel"],["reason","Reason"],["active","Active"],["created_at","Recorded"]]});
export function validPage(view,offset,channel){
 return Object.hasOwn(VIEWS,view)&&Number.isInteger(offset)&&offset>=0&&offset<=100000&&offset%50===0&&(channel===null||(view==="subscribers"&&["email","sms"].includes(channel)));
}
export function pageRows(payload){
 if(payload?.version!==1||!Array.isArray(payload.rows)||payload.rows.length>51||payload.rows.some(r=>!r||typeof r!=="object"||Array.isArray(r)))throw Error("Invalid response");
 return {rows:payload.rows.slice(0,50),more:payload.rows.length===51};
}
export function displayValue(value){
 if(value===null||value===undefined)return "—";
 if(typeof value==="boolean")return value?"Yes":"No";
 if(typeof value==="string"||typeof value==="number")return String(value);
 return "—";
}
export function attachCommunications(root,read,allowed){
 let generation=0;
 const sections=Array.from(root.querySelectorAll("[data-reader]"));
 const clear=()=>{
  generation++;
  for(const s of sections){
   s.querySelector("[data-records]").replaceChildren();
   s.querySelector("[data-read-status]").textContent="Select Load records to view this page.";
   s.querySelector("[data-prev]").hidden=true;s.querySelector("[data-next]").hidden=true;
   s.dataset.offset="0";
  }
 };
 async function load(s,offset=0){
  if(!allowed()||root.hidden||s.hidden)return;
  const view=s.dataset.reader,channel=s.querySelector("[data-channel]")?.value||null;
  if(!validPage(view,offset,channel))return;
  const serial=++generation,records=s.querySelector("[data-records]"),status=s.querySelector("[data-read-status]");
  records.replaceChildren();s.querySelector("[data-prev]").hidden=true;s.querySelector("[data-next]").hidden=true;
  status.textContent="Loading secure records…";
  try{
   const page=pageRows(await read(view,offset,channel));
   if(serial!==generation||!allowed()||root.hidden||s.hidden)return;
   for(const row of page.rows){
    const dl=document.createElement("dl");dl.className="record-card";
    for(const [field,label] of VIEWS[view]){
     const dt=document.createElement("dt");dt.textContent=label;
     const dd=document.createElement("dd");dd.textContent=displayValue(row[field]);dl.append(dt,dd);
    }
    records.append(dl);
   }
   s.dataset.offset=String(offset);
   status.textContent=page.rows.length?("Showing records "+(offset+1)+"–"+(offset+page.rows.length)+(page.more?" · more available":"")):(offset?"No records on this page.":"No records found in HAG Administration.");
   s.querySelector("[data-prev]").hidden=offset===0;s.querySelector("[data-next]").hidden=!page.more||offset>=100000;
  }catch{
   if(serial===generation&&allowed()&&!root.hidden&&!s.hidden)status.textContent="Unable to load secure records. Retry or sign in again.";
  }
 }
 for(const s of sections){
  s.querySelector("[data-load]").addEventListener("click",()=>void load(s,0));
  s.querySelector("[data-prev]").addEventListener("click",()=>void load(s,Math.max(0,Number(s.dataset.offset||0)-50)));
  s.querySelector("[data-next]").addEventListener("click",()=>void load(s,Number(s.dataset.offset||0)+50));
  s.querySelector("[data-channel]")?.addEventListener("change",()=>void load(s,0));
 }
 for(const button of root.querySelectorAll("[data-module]"))button.addEventListener("click",()=>{
  clear();
  const s=sections.find(x=>x.dataset.reader===button.dataset.module);
  if(s&&!s.hidden)void load(s);
 });
 clear();
 return {clear};
}
