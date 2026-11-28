// Offline preparation only: no HTTP client, OAuth redirect, token exchange or sending.
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {renderTestEmail} from "./email-templates.mjs";
export const GMAIL_SCOPE="https://www.googleapis.com/auth/gmail.send";
export const GMAIL_FROM="no-reply@heartlandathleticsgroup.com";
export const GMAIL_REPLY_TO="info@heartlandathleticsgroup.com";
export function scopeIsSendOnly(value){return typeof value==="string"&&value.trim()===GMAIL_SCOPE;}
export function createOfflineAuthorizationPlan({clientId,redirectUri}){
 if(typeof clientId!=="string"||! /^[a-zA-Z0-9._-]+[.]apps[.]googleusercontent[.]com$/.test(clientId)||!redirectUri||new URL(redirectUri).origin!=="https://preview.invalid"||new URL(redirectUri).pathname!=="/oauth/gmail/callback"||new URL(redirectUri).search||new URL(redirectUri).hash)throw Error("Isolated authorization plan only");
 const state=randomBytes(32).toString("base64url"),verifier=randomBytes(32).toString("base64url");
 const challenge=createHash("sha256").update(verifier).digest("base64url");
 // Return inert parameter data only. Never open the authorization endpoint.
 return {parameters:{client_id:clientId,redirect_uri:redirectUri,response_type:"code",scope:GMAIL_SCOPE,access_type:"offline",prompt:"consent",include_granted_scopes:"false",state,code_challenge:challenge,code_challenge_method:"S256"},verifier};
}
export function validateState(expected,received){
 if(typeof expected!=="string"||typeof received!=="string"||! /^[A-Za-z0-9_-]{43}$/.test(expected)||! /^[A-Za-z0-9_-]{43}$/.test(received))return false;
 return timingSafeEqual(Buffer.from(expected),Buffer.from(received));
}
export function buildSyntheticGmailMessage({id,destination,purpose,token}){
 if(typeof id!=="string"||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error("Invalid fixture job");
 const email=renderTestEmail({destination,purpose,token});
 const b64=s=>Buffer.from(s,"utf8").toString("base64").match(/.{1,76}/g).join("\r\n");
 const boundary="hag-"+id;
 const raw=["From: Heartland Athletics Group <"+GMAIL_FROM+">","Reply-To: "+GMAIL_REPLY_TO,"To: "+destination,"Subject: "+email.subject,"Message-ID: <"+id+"@preview.invalid>","MIME-Version: 1.0",'Content-Type: multipart/alternative; boundary="'+boundary+'"',"","--"+boundary,'Content-Type: text/plain; charset="UTF-8"',"Content-Transfer-Encoding: base64","",b64(email.text),"--"+boundary,'Content-Type: text/html; charset="UTF-8"',"Content-Transfer-Encoding: base64","",b64(email.html),"--"+boundary+"--",""].join("\r\n");
 return {raw:Buffer.from(raw,"utf8").toString("base64url")};
}
// A Gmail send response is not delivery proof; the API does not document an idempotency key.
// Never blindly retry an ambiguous send (including a network failure or 5xx).
export function classifyGmailOutcome(status,{requestDefinitelyNotSent=false}={}){
 if(Number.isInteger(status)&&status>=200&&status<300)return "accepted-not-delivered";
 if(status===401)return "authorization-required";
 if(status===429||status===403)return "hold-quota-or-policy-review";
 if(requestDefinitelyNotSent===true&&status===null)return "safe-preflight-retry";
 if(status===400||status===404)return "permanent-or-configuration-review";
 return "ambiguous-hold-no-resend";
}
