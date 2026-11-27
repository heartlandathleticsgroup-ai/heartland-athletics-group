// No dependencies. Validate the exact bytes forwarded to the native signature verifier.
const ORIGIN="https://heartlandathleticsgroup.com";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(){throw Error("Passkey verification failed");}
function b64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function decode(value,max){
 if(typeof value!=="string"||!value||value.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(value))fail();
 const bytes=Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=")),c=>c.charCodeAt(0));
 if(bytes.length>max||b64url(bytes)!==value)fail();return bytes;
}
export function validateAssertion(input){
 if(!input||typeof input.challenge_id!=="string"||!UUID.test(input.challenge_id))fail();
 const c=input.credential,r=c?.response;
 if(c?.type!=="public-key"||typeof c.id!=="string"||c.id!==c.rawId||!r)fail();
 const id=decode(c.rawId,1023),auth=decode(r.authenticatorData,4096);
 // UP + UV flags must both be set in the signed authenticatorData.
 if(auth.length<37||(auth[32]&5)!==5)fail();
 const client=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decode(r.clientDataJSON,4096)));
 if(client.type!=="webauthn.get"||client.origin!==ORIGIN||(client.crossOrigin!==undefined&&client.crossOrigin!==false)||client.topOrigin!==undefined)fail();
 decode(client.challenge,256);decode(r.signature,2048);
 if(r.userHandle!==null&&r.userHandle!==undefined)decode(r.userHandle,64);
 // Construct a fresh object so no alternative fields/duplicates reach the verifier.
 return {payload:{challenge_id:input.challenge_id,credential:{id:c.id,rawId:c.rawId,type:"public-key",response:{authenticatorData:r.authenticatorData,clientDataJSON:r.clientDataJSON,signature:r.signature,userHandle:r.userHandle??null},clientExtensionResults:{}}},credentialB64:btoa(String.fromCharCode(...id))};
}
export async function verifiedPasskey(input,{base,anon,service,request=fetch}){
 const {payload,credentialB64}=validateAssertion(input);
 // Auth verifies challenge, RP, origin, credential, and signature over the SAME UV-bearing bytes.
 // Native Auth consumes the one-use challenge; do not trust an unsigned browser "verified" flag.
 const response=await request(base+"/auth/v1/passkeys/authentication/verify",{method:"POST",headers:{apikey:anon,"Content-Type":"application/json"},body:JSON.stringify(payload),redirect:"error",signal:AbortSignal.timeout(12000)});
 if(!response.ok)fail();
 const result=await response.json();
 if(typeof result.access_token!=="string"||typeof result.refresh_token!=="string"||!UUID.test(result.user?.id??""))fail();
 // Only inspect a token returned by the fixed trusted Auth endpoint, never by the client.
 const parts=result.access_token.split(".");if(parts.length!==3)fail();
 const claims=JSON.parse(new TextDecoder().decode(decode(parts[1],16384)));
 if(claims.sub!==result.user.id||!UUID.test(claims.session_id??"")||claims.role!=="authenticated"||claims.iss!==base+"/auth/v1"||claims.is_anonymous!==false||!Array.isArray(claims.amr)||!claims.amr.some(x=>x?.method==="passkey"))fail();
 // Verify token with Auth as well; bind grant to the live matching native session.
 const check=await request(base+"/auth/v1/user",{headers:{apikey:anon,Authorization:"Bearer "+result.access_token},redirect:"error",signal:AbortSignal.timeout(8000)});
 if(!check.ok||(await check.json()).id!==claims.sub)fail();
 const grant=await request(base+"/rest/v1/rpc/hag_record_verified_passkey",{method:"POST",headers:{apikey:service,Authorization:"Bearer "+service,"Content-Type":"application/json"},body:JSON.stringify({p_session_id:claims.session_id,p_user_id:claims.sub,p_credential_b64:credentialB64}),redirect:"error",signal:AbortSignal.timeout(8000)});
 if(!grant.ok||(await grant.json())!==true)fail();
 return {access_token:result.access_token,refresh_token:result.refresh_token};
}
export {ORIGIN};
