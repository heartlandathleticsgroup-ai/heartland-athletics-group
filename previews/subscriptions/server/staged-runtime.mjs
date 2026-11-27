// Isolated runtime preparation only. No listener, secrets, real delivery, or default pool.
import {createGateway,createIngressGuard,createSimulatedDelivery} from "./gateway.mjs";
import {postgresAdapter} from "./postgres-adapter.mjs";
export function createBoundExecutor(pool,{max=4}={}){
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
   await client.query("SET LOCAL ROLE hag_subscription_runtime");
   const identity=await client.query("select current_user as role, session_user as login, (select not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit) from pg_roles where rolname=session_user) as narrow");
   const row=identity.rows?.[0];
   if(row?.role!=="hag_subscription_runtime"||row.login!=="hag_subscription_gateway_login"||row.narrow!==true)throw Error("Unexpected runtime identity");
   const result=await client.query(sql,args);
   await client.query("COMMIT");
   return result;
  }catch{
   if(client){try{await client.query("ROLLBACK");}catch{discard=true;}}
   throw Error("Private runtime unavailable");
  }finally{try{client?.release(discard);}finally{active--;}}
 };
}
export function createStagedRuntime({ordinaryPool,optoutPool,trustedSource,mode}){
 if(mode!=="isolated-test"||ordinaryPool===optoutPool||typeof trustedSource!=="function")throw Error("Isolated runtime only");
 const normal=postgresAdapter(createBoundExecutor(ordinaryPool,{max:4}));
 const optout=postgresAdapter(createBoundExecutor(optoutPool,{max:2}));
 const delivery=createSimulatedDelivery();
 const guard=createIngressGuard();
 // Separate pool capacity for existing opt-out tokens; no provider delivery.
 const make=db=>createGateway({db,delivery,source:trustedSource,ingress:guard});
 const ordinary=make(normal),withdraw=make(optout);
 return {handle:req=>new URL(req.url).pathname==="/subscriptions/unsubscribe"?withdraw(req):ordinary(req),drainSyntheticMessages:()=>delivery.drain()};
}
