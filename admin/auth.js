import {nextPanel,isSixDigit,expired} from "./auth-state.mjs";
import {signInWithVerifiedPasskey} from "./verified-passkey.mjs";
import {attachCommunications} from "./communications.mjs";
import {attachGmailControls,createGmailAdminClient,GMAIL_RELEASE_ENABLED} from "./gmail-controls.mjs";
import {attachSportAdmin,SPORT_ADMIN_RELEASE_ENABLED} from "./sport-admin.mjs";
import {attachCMS} from "./cms.mjs?v=3";
const BASE="https://unrqbfngcgvqnytxbtgj.supabase.co", PUBLISHABLE_KEY="sb_publishable_JeTzqF2gS0-pEHLs3VLOmg_GmK22bon";
const $=id=>document.getElementById(id);
const panels=["login","enroll","challenge","authorized"];
const notices={login:"Sign in with your approved administrator account.",enroll:"An authenticator is required before administrative access.",challenge:"Complete authenticator verification.",authorized:"Secure administrator session verified.",denied:"Access denied or session expired. Sign in again."};
const STORAGE="hag-admin-auth-v1", CLOCK="hag-admin-clock-v1";
let communications=null,cms=null,sportAdmin=null;
let gmailControls=null;
let client=null,busy=false,started=0,last=0,active=false,enrollment=null,currentPanel=null;
const say=s=>{$("notice").textContent=s;};
function passkeyAvailable(){return !!(window.isSecureContext&&window.PublicKeyCredential&&navigator.credentials&&client?.auth?.passkey?.startAuthentication&&client?.auth?.registerPasskey);}
function clearEnrollment(){enrollment=null;$("enroll-details").hidden=true;$("qr").removeAttribute("src");$("setup-key").textContent="";$("enroll-code").value="";$("start-enroll").disabled=false;}
function show(panel){
 if(panel!=="authorized"){communications?.clear();cms?.clear();gmailControls?.clear();sportAdmin?.clear();}
 panels.forEach(p=>{$(p+"-panel").hidden=p!==panel;});
 currentPanel=panel;$("signout").hidden=panel==="login";
 gmailControls?.refreshAccess?.();
 $("passkey-login").hidden=!passkeyAvailable();$("passkey-hint").hidden=!passkeyAvailable();$("register-passkey").hidden=!passkeyAvailable();
 if(panel!=="enroll")clearEnrollment();
 if(panel!=="challenge")$("challenge-code").value="";
 say(notices[panel]||notices.denied);
}
function saveClock(){sessionStorage.setItem(CLOCK,JSON.stringify({started,last}));}
function clearClock(){active=false;started=0;last=0;try{sessionStorage.removeItem(CLOCK);}catch{}}
function beginClock(){started=Date.now();last=started;active=true;saveClock();}
function data(result){if(result.error)throw result.error;return result.data;}
async function lock(text=notices.denied){
 show("login");clearClock();$("password").value="";$("challenge-code").value="";clearEnrollment();
 let confirmed=false;
 try{const result=await client.auth.signOut({scope:"local"});confirmed=!result.error;}catch{}
 try{sessionStorage.removeItem(STORAGE);}catch{}
 say(confirmed?text:text+" Local access is locked; server sign-out could not be confirmed.");
}
async function assess(){
 const {user}=data(await client.auth.getUser());
 if(!user){await lock();return;}
 const state=data(await client.rpc("hag_admin_access_state"));
 if(state==="denied"){await lock();return;}
 let factors=[];
 if(state==="challenge"){
   const all=data(await client.auth.mfa.listFactors());
   factors=(all.totp||[]).filter(f=>f.status==="verified");
 }
 const panel=nextPanel(state,factors);
 if(panel==="denied"){await lock();return;}
 if(panel==="challenge"){
   $("factor").replaceChildren(...factors.map(f=>{const o=document.createElement("option");o.value=f.id;o.textContent=f.friendly_name||"Authenticator";return o;}));
 }
 const entering=panel==='authorized'&&currentPanel!==panel;
 show(panel);
 if(panel==="authorized"){
   if(entering)void cms?.refresh();
   const assurance=data(await client.auth.mfa.getAuthenticatorAssuranceLevel());
   $("register-passkey").hidden=!passkeyAvailable()||assurance.currentLevel!=="aal2";
 }
}
async function run(fn,onError="Unable to complete this security step. Try again or use account recovery."){
 if(busy||!client)return;
 busy=true;
 const controls=[...document.querySelectorAll("button")];const wasDisabled=controls.map(x=>x.disabled);controls.forEach(x=>x.disabled=true);
 try{
  if(active&&expired(Date.now(),last,started)){await lock("Session ended. Sign in again.");return;}
  await fn();
 }catch{say(onError);}finally{controls.forEach((x,i)=>x.disabled=wasDisabled[i]);busy=false;gmailControls?.refreshAccess?.();}
}
function on(id,event,fn){$(id).addEventListener(event,ev=>{ev.preventDefault();void fn();});}
on("login-form","submit",()=>run(async()=>{
 const password=$("password").value,email=$("email").value.trim();$("password").value="";
 data(await client.auth.signInWithPassword({email,password}));beginClock();
 try{await assess();}catch{await lock("Unable to verify administrative access. Sign in again.");}
},"Sign-in failed. Check your credentials or contact the authorized account owner."));
on("passkey-login","click",()=>run(async()=>{
 if(!passkeyAvailable())throw Error("Unavailable");
 await signInWithVerifiedPasskey(client,BASE,PUBLISHABLE_KEY);beginClock();
 try{await assess();}catch{await lock("Unable to verify administrative access. Sign in again.");}
},"Passkey sign-in unavailable or cancelled. Use your password and authenticator."));
on("start-enroll","click",()=>run(async()=>{
 if(currentPanel!=="enroll"||enrollment)return;
 const state=data(await client.rpc("hag_admin_access_state"));if(state!=="enroll"){await assess();return;}
 const factor=data(await client.auth.mfa.enroll({factorType:"totp",friendlyName:"H.A.G. authenticator",issuer:"Heartland Athletics Group"}));
 if(!factor.id||!factor.totp?.secret||typeof factor.totp.qr_code!=="string"||!factor.totp.qr_code.startsWith("data:image/svg+xml"))throw Error("Invalid enrollment");
 enrollment=factor.id;$("qr").src=factor.totp.qr_code;$("setup-key").textContent=factor.totp.secret;$("enroll-details").hidden=false;say("Add this key to your authenticator and verify its code.");
}));
async function verify(factor,code){
 if(!factor||!isSixDigit(code))throw Error("Invalid code");
 const challenge=data(await client.auth.mfa.challenge({factorId:factor}));
 data(await client.auth.mfa.verify({factorId:factor,challengeId:challenge.id,code}));
 clearEnrollment();
 try{await assess();}catch{await lock("Unable to verify administrative access. Sign in again.");}
}
on("enroll-form","submit",()=>run(async()=>{const code=$("enroll-code").value;$("enroll-code").value="";await verify(enrollment,code);},"Code verification failed. Use a fresh code from your authenticator."));
on("challenge-form","submit",()=>run(async()=>{const code=$("challenge-code").value;$("challenge-code").value="";await verify($("factor").value,code);},"Code verification failed. Use a fresh code from your authenticator."));
on("register-passkey","click",()=>run(async()=>{
 if(currentPanel!=="authorized"||data(await client.rpc("hag_admin_access_state"))!=="authorized"){await lock();return;}
 if(!passkeyAvailable()||data(await client.auth.mfa.getAuthenticatorAssuranceLevel()).currentLevel!=="aal2")throw Error("Password and authenticator session required");
 data(await client.auth.registerPasskey());await assess();if(currentPanel==="authorized")say("Passkey registered. It requires administrator approval for code-free login.");
},"Passkey setup unavailable or cancelled. Password and authenticator sign-in remain available."));
on("signout","click",()=>run(()=>lock("Signed out.")));
function checkClock(){
 if(!active||busy)return;
 if(expired(Date.now(),last,started))void run(()=>lock("Session ended. Sign in again."));
}
function touch(){if(active&&!expired(Date.now(),last,started)){last=Date.now();try{saveClock();}catch{void run(()=>lock());}}else checkClock();}
["pointerdown","keydown","touchstart"].forEach(event=>document.addEventListener(event,touch,{passive:true}));
async function recheck(){
 if(!active||busy)return;
 if(expired(Date.now(),last,started)){await run(()=>lock("Session ended. Sign in again."));return;}
 if(currentPanel==="enroll"&&enrollment){await run(async()=>{try{const state=data(await client.rpc("hag_admin_access_state"));if(state!=="enroll")await assess();}catch{await lock("Unable to verify administrative access. Sign in again.");}});return;}
 await run(async()=>{try{await assess();}catch{await lock("Unable to verify administrative access. Sign in again.");}});
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void recheck();});
setInterval(checkClock,15000);setInterval(()=>void recheck(),60000);
async function init(){
 try{
  if(!window.isSecureContext||!window.supabase?.createClient)throw Error("Secure context required");
  // Public publishable key only; no privileged keys, passwords or provider secrets.
  client=window.supabase.createClient(BASE,PUBLISHABLE_KEY,{auth:{flowType:"pkce",detectSessionInUrl:false,storage:sessionStorage,storageKey:STORAGE,persistSession:true,autoRefreshToken:true}});
  const allowed=()=>active&&currentPanel==="authorized"&&!expired(Date.now(),last,started);
  communications=attachCommunications($("authorized-panel"),async(view,offset,channel)=>{
   if(!allowed())throw Error("Access unavailable");
   return data(await client.rpc("hag_communications_read",{p_view:view,p_offset:offset,p_channel:channel}));
  },allowed);
  cms=attachCMS($("authorized-panel"),async(name,args)=>{if(!allowed())throw Error("Access unavailable");return data(await client.rpc(name,args));},allowed);
  // No provider operations unless an independently approved release flips the lock.
  sportAdmin=attachSportAdmin($("authorized-panel"),{allowed,api:SPORT_ADMIN_RELEASE_ENABLED?async args=>{if(!allowed())throw Error("Access unavailable");const {p_action,...rest}=args;if(p_action.startsWith("draft-"))return data(await client.rpc("hag_sport_admin_drafts",{p_action:p_action.slice(6),...rest}));return data(await client.rpc(p_action==="count-union"?"hag_sport_admin_count":"hag_sport_admin",p_action==="count-union"?rest:args));}:null});
  const gmailApi=GMAIL_RELEASE_ENABLED?createGmailAdminClient({mode:"release-candidate",allowed,getBearer:async()=>{if(!allowed())throw Error("Access unavailable");const {session}=data(await client.auth.getSession());if(!allowed()||!session)throw Error("Access unavailable");return session.access_token;},request:globalThis.fetch.bind(globalThis)}):null;
  gmailControls=attachGmailControls($("authorized-panel"),{allowed,api:gmailApi});
  const {session}=data(await client.auth.getSession());
  if(!session){show("login");clearClock();return;}
  const saved=JSON.parse(sessionStorage.getItem(CLOCK)||"null");
  if(!saved||expired(Date.now(),saved.last,saved.started)){await lock("Session ended. Sign in again.");return;}
  started=saved.started;last=saved.last;active=true;
  await assess();
 }catch{if(client)await lock("Secure sign-in is unavailable. Please try again later.");else say("Secure sign-in is unavailable. Reload in a supported HTTPS browser.");}
}
void init();
