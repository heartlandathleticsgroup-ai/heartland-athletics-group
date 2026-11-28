// Isolated server-side binding candidate. No network, login, credential or entrypoint.
// Each caller gets one fixed SQL capability using an independently scoped executor.
const scalar = query => {
 if(typeof query!=="function")throw Error("Scoped executor required");
 return async(sql,params)=>{
  const r=await query(sql,params);
  if(r?.rows?.length!==1||!Object.hasOwn(r.rows[0],"value"))throw Error("Unexpected SMS database response");
  return r.rows[0].value;
 };
};
const bool = async p => {
 const value=await p;
 if(typeof value!=="boolean")throw Error("Unexpected SMS operation response");
 return value;
};
export function smsIntakeAdapter(query){
 const call=scalar(query);
 return Object.freeze({stage:e=>bool(call("select hag_private.sms_intake_stage($1::uuid,$2,$3,$4,$5::text[],$6::text[],$7,$8,$9) as value",[e.requestId,e.name,e.adult,e.destination,e.sports,e.updates,e.consent,e.version,e.hash]))});
}
export function smsInboundAdapter(query){
 const call=scalar(query);
 return Object.freeze({record:e=>bool(call("select hag_private.sms_inbound_event($1,$2,$3,$4,$5) as value",[e.messageSid,e.from,e.kind,e.code??null,e.reviewText??null]))});
}
export function smsReceiptAdapter(query){
 const call=scalar(query);
 return Object.freeze({record:e=>bool(call("select hag_private.sms_record_delivery($1,$2,$3,$4) as value",[e.messageSid,e.destination,e.status,e.errorCode??null]))});
}
export function smsDispatchAdapter(query){
 const call=scalar(query);
 return Object.freeze({
  claim:()=>call("select hag_private.sms_ack_claim() as value",[]),
  start:ticket=>bool(call("select hag_private.sms_ack_start($1::uuid) as value",[ticket])),
  finish:(ticket,outcome,providerSid)=>bool(call("select hag_private.sms_ack_finish($1::uuid,$2,$3) as value",[ticket,outcome,providerSid??null]))
 });
}
