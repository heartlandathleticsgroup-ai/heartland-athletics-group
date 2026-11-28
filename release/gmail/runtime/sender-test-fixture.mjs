// Isolated acceptance fixture only. No hosted entrypoint, production transport or deployment.
import {Buffer} from "node:buffer";
import {GMAIL_SCOPE,GMAIL_FROM,GMAIL_REPLY_TO,safeToken} from "./policy.mjs";
import {parseGrant,createBoundedHttp} from "./protocol.mjs";
const recipient="jhawkins@heartlandathleticsgroup.com";
const idOk=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
export const TEST_SUBJECT="H.A.G. sender verification — private test";
export function renderSenderTest({id,to,postalFooter}){
 if(!idOk(id)||to!==recipient||typeof postalFooter!=="string"||postalFooter.length<15||postalFooter.length>300||/[\x00-\x1f\x7f]/.test(postalFooter))throw Error("Invalid private test");
 // ASCII MIME subject for predictable header inspection, no marketing or live subscriber links.
 const raw=["From: Heartland Athletics Group <"+GMAIL_FROM+">","Reply-To: "+GMAIL_REPLY_TO,"To: "+to,"Subject: H.A.G. sender verification - private test","Message-ID: <"+id+"@heartlandathleticsgroup.com>","MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","","Private owner-authorized sender verification. This is not a subscription, advertisement or campaign. No action is required.","","Heartland Athletics Group LLC",postalFooter,"Questions: "+GMAIL_REPLY_TO,""].join("\r\n");
 return {raw:Buffer.from(raw,"utf8").toString("base64url")};
}
export function createSenderTestFixture({mode,claim,finish,verifyAdmin,vault,fetchFixture,clientId,clientSecret,postalFooter,now=Date.now}){
 if(mode!=="isolated-acceptance"||fetchFixture===globalThis.fetch||typeof claim!=="function"||typeof finish!=="function"||typeof verifyAdmin!=="function"||!vault||!safeToken(clientSecret)||!clientId)throw Error("Isolated sender test only");
 const http=createBoundedHttp({mode:"release-candidate",fetchFixture});
 return async({testId,bearer})=>{
  if(!idOk(testId))return "not-authorized";
  const proof=await verifyAdmin(bearer);
  if(proof?.gate!=="authorized"||proof.sessionActive!==true||!Number.isFinite(proof.stepUpAt)||proof.stepUpAt>now()||now()-proof.stepUpAt>300000)return "not-authorized";
  const ticket=await claim(testId);
  if(!ticket)return "not-authorized";
  let outcome="ambiguous-hold-no-resend";
  try{
   if(ticket.testId!==testId||ticket.recipient!==recipient||ticket.keyVersion!==vault.version)throw Error("Ticket invalid");
   const msg=renderSenderTest({id:testId,to:ticket.recipient,postalFooter});
   const refresh=vault.open(ticket.credential,"refresh").token;if(!safeToken(refresh))throw Error("Token invalid");
   const grant=parseGrant(await http("https://oauth2.googleapis.com/token",{headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"refresh_token",refresh_token:refresh}).toString()}),{refresh:true,previousScope:GMAIL_SCOPE});
   if(!grant)outcome="authorization-required";
   else{
    // Recheck the same fresh authorized actor/session before one provider attempt.
    const fresh=await verifyAdmin(bearer);
    if(fresh?.actor!==proof.actor||fresh?.session!==proof.session||fresh?.gate!=="authorized"||fresh.sessionActive!==true||!Number.isFinite(fresh.stepUpAt)||fresh.stepUpAt>now()||now()-fresh.stepUpAt>300000)outcome="authorization-required";
    else{
     const r=await http("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{headers:{Authorization:"Bearer "+grant.access_token,"Content-Type":"application/json"},body:JSON.stringify(msg)});
     if(r.status>=200&&r.status<300&&typeof r.body?.id==="string"&&/^[A-Za-z0-9_-]{1,256}$/.test(r.body.id))outcome="accepted-not-delivered";
     else if(r.status>=400&&r.status<500)outcome="provider-rejected";
    }
   }
  }catch{/* Do not retry a claimed or ambiguous attempt. */}
  try{if(!await finish(testId,outcome))return "ambiguous-hold-no-resend";}catch{return "ambiguous-hold-no-resend";}
  return outcome;
 };
}
