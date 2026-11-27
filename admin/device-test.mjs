// First-party passkey flow. Native Auth issues a challenge, the gateway verifies
// the exact signed assertion with Auth and records only its verified session.
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(s.length/4)*4,"=")),c=>c.charCodeAt(0));
const encode=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function getAssertion(client){
 const {data,error}=await client.auth.passkey.startAuthentication();
 if(error||!data?.options||!data.challenge_id)throw Error("Passkey challenge unavailable");
 const raw=data.options;
 const options=typeof PublicKeyCredential.parseRequestOptionsFromJSON==="function"?PublicKeyCredential.parseRequestOptionsFromJSON(raw):{...raw,challenge:decode(raw.challenge),allowCredentials:raw.allowCredentials?.map(c=>({...c,id:decode(c.id)}))};
 options.userVerification="required";
 const c=await navigator.credentials.get({publicKey:options});
 if(!c||c.type!=="public-key")throw Error("Passkey unavailable");
 const r=c.response;
 const credential={id:c.id,rawId:encode(c.rawId),type:c.type,response:{authenticatorData:encode(r.authenticatorData),clientDataJSON:encode(r.clientDataJSON),signature:encode(r.signature),userHandle:r.userHandle?encode(r.userHandle):null}};
 return {challenge_id:data.challenge_id,credential};
}

const button=document.getElementById("test"),status=document.getElementById("status");
const BASE="https://unrqbfngcgvqnytxbtgj.supabase.co",KEY="sb_publishable_JeTzqF2gS0-pEHLs3VLOmg_GmK22bon";
let client;
try {
 if(!window.isSecureContext||!window.PublicKeyCredential||!navigator.credentials||!window.supabase?.createClient)throw Error();
 client=window.supabase.createClient(BASE,KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:"hag-passkey-device-test-only"}});
 if(!client.auth.passkey?.startAuthentication)throw Error();
 status.textContent="Ready for live security checks. Two device verifications may be required.";
 button.disabled=false;
}catch{status.textContent="This browser or hosted library does not support the test. Use the existing login.";}

const send=body=>fetch(BASE+"/functions/v1/hag-admin-passkey",{method:"POST",headers:{apikey:KEY,"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
const clone=value=>JSON.parse(JSON.stringify(value));
async function reject(body,label){
 const r=await send(body);
 if(r.ok){const data=await r.json();try{await client.auth.setSession(data);await client.auth.signOut({scope:"local"});}catch{}throw Error(label+" unexpectedly accepted");}
 if(r.status!==401)throw Error(label+" inconclusive (HTTP "+r.status+")");
}
button.addEventListener("click",async()=>{
 button.disabled=true;
 const passed=[];
 const note=t=>{status.textContent=passed.join(" • ")+(passed.length?" • ":"")+t;};
 try{
  note("First device verification: live security checks");
  const assertion=await getAssertion(client);
  const uv=clone(assertion), bytes=decode(uv.credential.response.authenticatorData);
  bytes[32]&=~4;uv.credential.response.authenticatorData=encode(bytes);
  await reject(uv,"Missing user verification");passed.push("PASS: missing UV rejected");
  const origin=clone(assertion), cd=JSON.parse(new TextDecoder().decode(decode(origin.credential.response.clientDataJSON)));
  cd.origin="https://invalid.example";origin.credential.response.clientDataJSON=encode(new TextEncoder().encode(JSON.stringify(cd)));
  await reject(origin,"Wrong origin");passed.push("PASS: wrong origin rejected");
  const good=await send(assertion);if(!good.ok)throw Error("Valid assertion failed (HTTP "+good.status+")");
  const tokens=await good.json(), result=await client.auth.setSession(tokens);
  if(result.error||!result.data?.session)throw Error("Session setup failed");
  const state=await client.rpc("hag_admin_access_state");
  if(state.error||state.data!=="challenge")throw Error("Legacy policy check failed");
  passed.push("PASS: valid assertion and legacy MFA policy");
  await reject(assertion,"Replay");passed.push("PASS: replay rejected");
  const logout=await client.auth.signOut({scope:"local"});
  if(logout.error)throw Error("Sign-out failed");
  passed.push("PASS: session signed out");
  note("Second device verification: signature integrity");
  const fresh=await getAssertion(client), sig=decode(fresh.credential.response.signature);
  sig[sig.length-1]^=1;fresh.credential.response.signature=encode(sig);
  await reject(fresh,"Modified signature");passed.push("PASS: modified signature rejected");
  note("ALL LIVE CHECKS PASSED.");
 }catch(e){note("STOP: "+(e instanceof Error?e.message:"Test did not complete"));}
 finally{try{await client.auth.signOut({scope:"local"});}catch{}button.disabled=false;}
});
