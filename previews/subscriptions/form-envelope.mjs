// Shared form-to-gateway contract. The offline preview only builds envelopes.
import {CONSENT_VERSION,validateRequest,validatePreferenceAccess} from "./consent.mjs";
export function subscriptionEnvelope(form,requestId){
 validateRequest(form);
 return {action:"subscribe",requestId,version:CONSENT_VERSION,form};
}
export function accessEnvelope(form,requestId,purpose="manage"){
 validatePreferenceAccess(form);
 if(!["manage","unsubscribe"].includes(purpose))throw Error("Invalid preference request.");
 return {action:"access",requestId,purpose,form};
}
