// Isolated runtime preparation only. No listener, secrets, real delivery, or default pool.
import {createGateway,createIngressGuard,createSimulatedDelivery} from "./gateway.mjs";
import {durableEmailAdapter,durableEmailWorker} from "./durable-email.mjs";
import {postgresAdapter} from "./postgres-adapter.mjs";
const identities=Object.freeze({gateway:["hag_subscription_runtime","hag_subscription_gateway_login"],worker:["hag_email_worker","hag_email_worker_login"]});
export function createBoundExecutor(pool,{max=4,kind="gateway"}={}){
 if(!Object.hasOwn(identities,kind))throw Error("Unknown runtime identity");
 const [role,login]=identities[kind];
 if(!pool||typeof pool.connect!=="function"||!Number.isInteger(max)||max<1||max>8)throw Error("Invalid isolated pool");
 let active=0;
 return async(sql,args)=>{
  if(active>=max)throw Error("Runtime busy");
  active++;
  let client,discard=false;
  try{
   client=await pool.connect(); // driver must enforce acquisition timeout
   await client.query("BEGIN");
   await client.query("SET LOCAL statement_timeout = '3000ms'");
   await client.query("SET LOCAL lock_timeout = '1000ms'");
   await client.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
   await client.query("SET LOCAL ROLE "+role);
   const identity=await client.query("select current_user as role, session_user as login, (select not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit) from pg_roles where rolname=session_user) as narrow");
   const row=identity.rows?.[0];
   if(row?.role!==role||row.login!==login||row.narrow!==true)throw Error("Unexpected runtime identity");
   const result=await client.query(sql,args);
   await client.query("COMMIT");
   return result;
  }catch{
   if(client){try{await client.query("ROLLBACK");}catch{discard=true;}}
   throw Error("Private runtime unavailable");
  }finally{try{client?.release(discard);}finally{active--;}}
 };
}
export function createStagedRuntime({ordinaryPool,optoutPool,workerPool,trustedSource,mode,emailKey,emailKeyVersion,workerKeys}){
 if(mode!=="isolated-test"||!ordinaryPool||!optoutPool||!workerPool||new Set([ordinaryPool,optoutPool,workerPool]).size!==3||typeof trustedSource!=="function"||typeof workerKeys!=="function")throw Error("Isolated runtime only");
 const query=createBoundExecutor(ordinaryPool,{max:4});
 const normal=postgresAdapter(query);
 const optout=postgresAdapter(createBoundExecutor(optoutPool,{max:2}));
 const email=durableEmailAdapter(query,emailKey,emailKeyVersion);
 const worker=durableEmailWorker(createBoundExecutor(workerPool,{max:2,kind:"worker"}),workerKeys);
 const sms=createSimulatedDelivery();
 const delivery={mode:"simulation",accept:v=>{if(v.channel!=="sms")throw Error("Atomic email required");return sms.accept(v);}};
 const guard=createIngressGuard();
 const ordinary=createGateway({db:{...normal,enqueueEmail:email.enqueue},delivery,source:trustedSource,ingress:guard,atomicEmail:true});
 const withdraw=createGateway({db:{...optout,optInEmail:async()=>{throw Error("Unsubscribe only");},enqueueEmail:async()=>{throw Error("Unsubscribe only");},issueSms:async()=>{throw Error("Unsubscribe only");}},delivery,source:trustedSource,ingress:guard,atomicEmail:true});
 return {handle:req=>new URL(req.url).pathname==="/subscriptions/unsubscribe"?withdraw(req):ordinary(req),drainSyntheticMessages:()=>sms.drain(),pumpSyntheticEmail:()=>worker.pump()};
}
