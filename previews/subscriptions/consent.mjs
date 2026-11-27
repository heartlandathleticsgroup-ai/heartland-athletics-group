// Unpublished preview only. No transport, storage, analytics, tokens or delivery.
export const TOPICS=Object.freeze([
 ["hag-announcements","General H.A.G. announcements"],
 ["enforcers-updates","Heartland Enforcers Basketball Club"],
 ["enforcers-tryouts","Upcoming tryouts"],
 ["gus-macker-local","Gus Macker - Quincy local event updates"],
 ["gus-macker-registration","Gus Macker - Quincy registration opening"],
 ["camps-clinics","Camps and clinics"],
 ["tournaments-events","Tournaments and events"],
 ["sponsorship-updates","Sponsorship opportunities"],
 ["volunteer-updates","Volunteer opportunities"]
].map(Object.freeze));
export const CONSENT_VERSION="draft-3c3-v1";
export const CONSENT=Object.freeze({
 email:"I agree to receive marketing email from Heartland Athletics Group for the email topics I select. I can unsubscribe at any time. Consent is optional.",
 sms:"I agree to receive recurring automated marketing text messages from Heartland Athletics Group at the number I provide, for the SMS topics I select. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase."
});
const codes=new Set(TOPICS.map(t=>t[0]));
const channels=["email","sms"];
function fail(message){throw new Error(message);}
function exact(value,keys){
 return !!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
export function normalizeDestination(channel,input){
 if(typeof input!=="string")fail("Enter a valid contact method.");
 const value=input.trim();
 if(channel==="email"){
  if(value.length>254||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(value)||/[\u0000-\u001f\u007f]/.test(value))fail("Enter a valid email address.");
  return value.toLowerCase();
 }
 if(channel==="sms"){
  // Require explicit international number; never infer country or silently change digits.
  if(!/^\+[1-9][0-9]{7,14}$/.test(value))fail("Enter a phone number with country code, e.g. +12025550123.");
  return value;
 }
 fail("Unknown channel.");
}
export function validateRequest(input){
 if(!exact(input,["name","adult","email","sms"])||input.adult!==true)fail("Confirm you are 18 or older.");
 if(typeof input.name!=="string"||!input.name.trim()||input.name.trim().length>120||/[\u0000-\u001f\u007f]/.test(input.name))fail("Enter a name of 1–120 characters.");
 const requests=[];
 for(const channel of channels){
  const choice=input[channel];
  if(!exact(choice,["enabled","destination","topics","consent"])||typeof choice.enabled!=="boolean"||typeof choice.consent!=="boolean"||typeof choice.destination!=="string"||!Array.isArray(choice.topics))fail("Invalid channel selection.");
  if(!choice.enabled){
   if(choice.consent||choice.topics.length||choice.destination!=="")fail("Remove selections from the disabled channel.");
   continue;
  }
  if(choice.consent!==true)fail("Consent is required for each selected channel.");
  if(choice.topics.length<1||choice.topics.length>TOPICS.length||new Set(choice.topics).size!==choice.topics.length||choice.topics.some(t=>!codes.has(t)))fail("Select valid, distinct topics for each channel.");
  requests.push({channel,destination:normalizeDestination(channel,choice.destination),topics:[...choice.topics].sort(),consentVersion:CONSENT_VERSION,consentText:CONSENT[channel],status:"pending"});
 }
 if(!requests.length)fail("Choose at least one communication channel.");
 return {name:input.name.trim(),adultConfirmed:true,requests};
}
export function validatePreferenceAccess(input){
 if(!exact(input,["channel","destination"])||!channels.includes(input.channel))fail("Select email or SMS.");
 return {channel:input.channel,destination:normalizeDestination(input.channel,input.destination)};
}
