// Fixture-only application adapter; no provider calls or live route.
import {randomBytes,createHash} from "node:crypto";
import {selectionPayload,VERSION} from "./sport-contract.mjs";
const validId=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export function createTwilioJoinFixture({mode,number,ready,stage,randomCode=()=>randomBytes(12).toString("hex")}){
 if(mode!=="isolated-acceptance"||!/^\+18(?:00|33|44|55|66|77|88)[0-9]{7}$/.test(number)||typeof ready!=="function"||typeof stage!=="function")throw Error("SMS unavailable");
 return async({requestId,version,form,catalog})=>{
  if(version!==VERSION||!validId(requestId)||!await ready())throw Error("SMS unavailable");
  const v=selectionPayload(form,catalog);
  if(!v.sms.enabled||!/^\+1[2-9][0-9]{9}$/.test(v.sms.destination))throw Error("US SMS required");
  const code=randomCode();if(!/^[a-f0-9]{24}$/.test(code))throw Error("Invalid code");
  // Always generic response; denied/duplicate requests must not enumerate existing numbers.
  // A decoy code has no matching pending request. Never auto-replace an existing code.
  await stage({requestId,name:v.name,adult:v.adult,...v.sms,version,hash:createHash("sha256").update(code).digest("hex")});
  return {number,command:"JOIN "+code,expiresMinutes:15};
 };
}
