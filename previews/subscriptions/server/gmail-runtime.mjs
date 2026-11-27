// Isolated wiring only. No live listener, driver, secrets, or default network client.
// Do not use a service-role credential for the proof RPC. Session resolver is a
// server-side, trusted bridge; browser-supplied actor/session claims are ignored.
import {createBoundExecutor} from "./staged-runtime.mjs";
import {createGmailBackend,gmailControlDb,gmailDispatchDb} from "./gmail-backend.mjs";
export function createAdminProofVerifier({resolveSession,userRpc}){
 if(typeof resolveSession!=="function"||typeof userRpc!=="function")throw Error("Trusted user session bridge required");
 return async req=>{
  try{
   const session=await resolveSession(req);
   if(typeof session?.bearer!=="string"||!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(session.bearer))return null;
   // userRpc must authenticate the bearer as this user, never as service_role.
   const proof=await userRpc({name:"hag_gmail_admin_proof",args:{},bearer:session.bearer});
   return proof?.error?null:proof?.data??null;
  }catch{return null;}
 };
}
export function createGmailStagedRuntime({mode,controlPool,dispatchPool,resolveSession,userRpc,...options}){
 if(mode!=="isolated-test"||!controlPool||!dispatchPool||controlPool===dispatchPool)throw Error("Separate isolated Gmail pools required");
 return createGmailBackend({...options,mode,control:gmailControlDb(createBoundExecutor(controlPool,{max:2,kind:"gmailControl"})),dispatch:gmailDispatchDb(createBoundExecutor(dispatchPool,{max:2,kind:"gmailDispatch"})),verifyAdmin:createAdminProofVerifier({resolveSession,userRpc})});
}
