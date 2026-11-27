export function nextPanel(state, factors){
 if(state==="authorized")return "authorized";
 if(state==="enroll")return "enroll";
 if(state==="challenge"&&Array.isArray(factors)&&factors.length>0)return "challenge";
 return "denied";
}
export function isSixDigit(code){return typeof code==="string"&&/^[0-9]{6}$/.test(code);}
export function expired(now,last,started){return !Number.isFinite(last)||!Number.isFinite(started)||last<=0||started<=0||now<last||now<started||now-last>=20*60*1000||now-started>=12*60*60*1000;}
