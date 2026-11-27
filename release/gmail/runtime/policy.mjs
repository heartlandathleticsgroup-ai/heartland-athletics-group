export const GMAIL_SCOPE="https://www.googleapis.com/auth/gmail.send";
export const GMAIL_FROM="no-reply@heartlandathleticsgroup.com";
export const GMAIL_REPLY_TO="info@heartlandathleticsgroup.com";
export const scopeIsSendOnly=x=>typeof x==="string"&&x.trim()===GMAIL_SCOPE;
export const safeToken=x=>typeof x==="string"&&x.length>=8&&x.length<=4096&&/^[\x21-\x7e]+$/.test(x);
export const jwt=x=>typeof x==="string"&&x.length<=4096&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x);
export function validEmail(d){
 if(typeof d!=="string"||d.length>254||d!==d.trim().toLowerCase()||d.includes(".."))return false;
 const [local,domain,...rest]=d.split("@");
 return rest.length===0&&!!domain&&local.length>=1&&local.length<=64&&!local.startsWith(".")&&!local.endsWith(".")&&/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)&&domain.includes(".")&&domain.split(".").every(l=>l.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l));
}
export function classifyGmailOutcome(status){if(Number.isInteger(status)&&status>=200&&status<300)return "accepted-not-delivered";if(status===401)return "authorization-required";if(status===403||status===429)return "hold-quota-or-policy-review";if(status===400||status===404)return "permanent-or-configuration-review";return "ambiguous-hold-no-resend";}
