// Node server draft; shared handler also runs in a synthetic-only browser harness.
import {isIP} from "node:net";
import {createGatewayCore,createIngressGuardCore} from "./gateway-core.mjs";
export {GENERIC,SIGNUP,createSimulatedDelivery} from "./gateway-core.mjs";
function canonicalSource(s){if(typeof s!=="string"||!isIP(s))return null;return isIP(s)===4?s:new URL("http://["+s+"]/").hostname.slice(1,-1);}
export function createIngressGuard(options){return createIngressGuardCore(canonicalSource,options);}
export function createGateway(options){return createGatewayCore({...options,canonicalSource});}
