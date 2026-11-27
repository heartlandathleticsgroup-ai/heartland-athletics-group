// Offline demonstration adapter. Only the synthetic in-memory DB is used.
import {createGatewayCore,createIngressGuardCore,createSimulatedDelivery} from "./server/gateway-core.mjs";
import {createFixtureDatabase} from "./fixture-db.mjs";
import {subscriptionEnvelope,accessEnvelope} from "./form-envelope.mjs";
const canonical=s=>s==="192.0.2.1"?s:null;
export function createPreferenceSimulation({now=Date.now}={}){
 let offset=0;
 const clock=()=>now()+offset, delivery=createSimulatedDelivery();
 const db=createFixtureDatabase({now:clock});
 const handle=createGatewayCore({db,delivery,source:()=>"192.0.2.1",ingress:createIngressGuardCore(canonical,{clock}),canonicalSource:canonical});
 async function call(payload){
  const response=await handle(new Request("https://preview.invalid/subscriptions",{method:"POST",headers:{origin:"https://heartlandathleticsgroup.com","content-type":"application/json"},body:JSON.stringify(payload)}));
  return {status:response.status,body:await response.json()};
 }
 return {call,subscribe:form=>call(subscriptionEnvelope(form,crypto.randomUUID())),access:(form,purpose)=>call(accessEnvelope(form,crypto.randomUUID(),purpose)),takeMessages:()=>delivery.drain(),expireLinks:()=>{offset+=61*86400000;}};
}
