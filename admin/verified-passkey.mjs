// First-party passkey flow. Native Auth issues a challenge, the gateway verifies
// the exact signed assertion with Auth and records only its verified session.
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(s.length/4)*4,"=")),c=>c.charCodeAt(0));
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
export async function signInWithVerifiedPasskey(client,base,publishableKey){
 const {data,error}=await client.auth.passkey.startAuthentication();
 if(error||!data?.options||!data.challenge_id)throw Error("Passkey challenge unavailable");
 const raw=data.options;
 const options=typeof PublicKeyCredential.parseRequestOptionsFromJSON==="function"?PublicKeyCredential.parseRequestOptionsFromJSON(raw):{...raw,challenge:decode(raw.challenge),allowCredentials:raw.allowCredentials?.map(c=>({...c,id:decode(c.id)}))};
 options.userVerification="required";
 const c=await navigator.credentials.get({publicKey:options});
 if(!c||c.type!=="public-key")throw Error("Passkey unavailable");
 const r=c.response;
 const credential={id:c.id,rawId:encode(c.rawId),type:c.type,response:{authenticatorData:encode(r.authenticatorData),clientDataJSON:encode(r.clientDataJSON),signature:encode(r.signature),userHandle:r.userHandle?encode(r.userHandle):null}};
 const response=await fetch(base+"/functions/v1/hag-admin-passkey",{method:"POST",headers:{apikey:publishableKey,"Content-Type":"application/json"},body:JSON.stringify({challenge_id:data.challenge_id,credential}),cache:"no-store",redirect:"error"});
 if(!response.ok)throw Error("Passkey unavailable");
 const session=await response.json();
 if(typeof session.access_token!=="string"||typeof session.refresh_token!=="string")throw Error("Invalid session");
 const result=await client.auth.setSession(session);
 if(result.error)throw result.error;
 return result.data;
}
