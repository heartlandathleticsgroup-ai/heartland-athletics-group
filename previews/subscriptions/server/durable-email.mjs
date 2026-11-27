// Disabled draft adapter. No API key, HTTP client, endpoint, DNS or provider calls.
export function createResendAdapter(){
 return Object.freeze({enabled:false,async send(){throw Error("Resend integration is disabled; explicit activation and security acceptance required");}});
}
// Fixed-query adapters for synthetic-only isolated database, separate worker identity.
export function durableEmailAdapter(query,key,keyVersion){
 if(typeof query!=="function"||typeof key!=="string"||! /^[a-f0-9]{64}$/.test(key)||! /^[a-zA-Z0-9_-]{1,32}$/.test(keyVersion))throw Error("Invalid isolated configuration");
 return {async enqueue(id,action,item){if(item.channel!=="email"||!item.destination.endsWith(".invalid"))throw Error("Synthetic email only");await query("select hag_private.subscription_enqueue_email($1::uuid,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11)",[id,action,item.name??null,item.adult??null,item.destination,item.topics??null,item.consentText!==undefined?true:null,item.consentVersion??null,item.purpose,key,keyVersion]);}};
}
export function durableEmailWorker(query,keys){
 if(typeof query!=="function"||typeof keys!=="function")throw Error("Isolated worker configuration required");
 return {async pump(outcome="accept"){
 const result=await query("select hag_private.subscription_email_claim() as value",[]);
 const job=result.rows?.[0]?.value;if(!job)return "empty";
 // Reconciliation must remain possible even if an old encryption key was retired.
 let key=null;try{const candidate=keys(job.key_version);if(typeof candidate==="string"&&/^[a-f0-9]{64}$/.test(candidate))key=candidate;}catch{/* Fail closed; SQL can reconcile existing acceptance without decrypting. */}
 const step=await query("select hag_private.subscription_email_sim_step($1::uuid,$2::uuid,$3,$4,$5) as value",[job.id,job.lease,key,job.key_version,outcome]);
 return step.rows?.[0]?.value;
 }};
}
