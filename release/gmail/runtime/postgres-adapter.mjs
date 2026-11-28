// E.9 release candidate, not deployed. Real network gated by private configuration.
// Server-only draft adapter. Executor must be a trusted, parameterized PostgreSQL
// connection using the narrow gateway role; no generic RPC endpoint or browser database credentials.
// No driver, connection string or live connection is supplied.
export function postgresAdapter(query){
 if(typeof query!=="function")throw Error("Trusted query executor required");
 const scalar=async(sql,args)=>{const r=await query(sql,args);if(r?.rows?.length!==1)throw Error("Unexpected database response");return r.rows[0].value;};
 return {
  budget:(source,action)=>scalar("select hag_private.subscription_gateway_budget($1,$2) as value",[source,action]),
  optInEmail:(id,item)=>{if(item.channel!=="email")throw Error("Email only");return scalar("select hag_private.subscription_email_opt_in($1::uuid,$2,$3,$4,$5::text[],$6,$7) as value",[id,item.name,item.adult,item.destination,item.topics,item.consentText!==undefined,item.consentVersion]);},
  issueSms:(id,action,item)=>{if(item.channel!=="sms")throw Error("SMS only");return scalar("select hag_private.subscription_gateway_issue_sms($1::uuid,$2,$3,$4,$5,$6::text[],$7,$8,$9) as value",[id,action,item.name??null,item.adult??null,item.destination,item.topics??null,item.consentText!==undefined?true:null,item.consentVersion??null,item.purpose]);},
  inspect:token=>scalar("select hag_private.subscription_confirm_scope($1) as value",[token]),
  redeem:(token,purpose)=>scalar("select hag_private.subscription_redeem($1,$2) as value",[token,purpose]),
  edit:x=>scalar("select hag_private.subscription_edit($1,$2::text[],$3::text[],$4,$5,$6) as value",[x.token,x.add,x.remove,x.adult,x.consent,x.version])
 };
}
