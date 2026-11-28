undefined
export function selectionPayload({name,adult,email,sms},catalog=SPORTS.map(x=>x[0])){
 if(typeof name!=="string"||!name.trim()||name.trim().length>120||/[\u0000-\u001f\u007f]/.test(name)||adult!==true)throw Error("Enter your name and confirm adult eligibility.");
 const out={name:name.trim(),adult:true};
 for(const channel of ["email","sms"]){
 const v=channel==="email"?email:sms;
 if(!v||typeof v.enabled!=="boolean")throw Error("Invalid channel.");
 if(!v.enabled){out[channel]={enabled:false,destination:"",sports:[],updates:[],consent:false};continue;}
 if(v.consent!==true||!validSelection(v.sports,v.updates,catalog)||typeof v.destination!=="string")throw Error("Choose valid interests and consent for each selected channel.");
 const dest=v.destination.trim();
 if(channel==="email"?dest.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest):!/^\+[1-9][0-9]{7,14}$/.test(dest))throw Error("Enter a valid contact method.");
 out[channel]={enabled:true,destination:channel==="email"?dest.toLowerCase():dest,sports:[...v.sports],updates:[...v.updates],consent:true};
 }
 if(!out.email.enabled&&!out.sms.enabled)throw Error("Select a communication method.");
 return out;
}
export const SPORT_CONSENT_SUFFIX=" I choose the listed sports and types of updates for this channel. Sport-specific updates must match both choices. All current and future sports includes sports added later only if selected.";
