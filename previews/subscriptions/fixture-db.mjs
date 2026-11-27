// Synthetic-only, in-memory database for the unpublished preference center.
// No actual database, network transport, browser storage, or real destinations.
import {TOPICS} from "../consent.mjs";
const codes=new Set(TOPICS.map(t=>t[0]));
export function createFixtureDatabase({now=Date.now,random=()=>crypto.getRandomValues(new Uint8Array(32))}={}){
 const methods=new Map(),tokens=new Map(),keys=new Set(),buckets=new Map();
 const fixture=(c,d)=>c==="email"?d==="fixture@example.invalid":c==="sms"&&d==="+12025550123";
 const method=(c,d)=>methods.get(c+":"+d);
 const issueToken=(m,p,topics=[])=>{
  if(tokens.size>=200)throw Error("Reset simulation");
  const raw=Array.from(random(),b=>b.toString(16).padStart(2,"0")).join("");
  tokens.set(raw,{m,p,topics,expires:now()+(p==="edit"?900000:p==="unsubscribe"?5184000000:1800000),used:false});
  return raw;
 };
 const take=(raw,p)=>{const t=tokens.get(raw);if(!t||t.p!==p||t.used||t.expires<=now())return null;t.used=true;return t;};
 const invalidate=m=>{for(const t of tokens.values())if(t.m===m&&t.p!=="unsubscribe")t.used=true;};
 const view=m=>[...m.topics].map(([topic,status])=>({topic,status}));
 return {
  async budget(src,action){const k=src+":"+(action==="unsubscribe"?"optout":"ordinary")+":"+Math.floor(now()/60000);const n=(buckets.get(k)||0)+1;buckets.set(k,n);return n<=20;},
  async issue(id,action,item){
   if(!fixture(item.channel,item.destination)||keys.size>=200)return null;
   const k=id+":"+item.channel;if(keys.has(k))return null;keys.add(k);
   const mk=item.channel+":"+item.destination;
   let m=method(item.channel,item.destination);
   if(action==="access")return m?issueToken(m,item.purpose):null;
   if(!m){m={channel:item.channel,topics:new Map(),suppressed:false};methods.set(mk,m);}
   if(m.suppressed)return null;
   for(const topic of item.topics)if(!m.topics.has(topic))m.topics.set(topic,"pending");
   const pending=item.topics.filter(t=>m.topics.get(t)==="pending");
   return pending.length?issueToken(m,"confirm",pending):null;
  },
  async redeem(raw,p){
   const t=take(raw,p);if(!t)return null;const m=t.m;
   if(p==="confirm"){if(m.suppressed)return null;for(const topic of t.topics)if(m.topics.get(topic)==="pending")m.topics.set(topic,"active");return {ok:true};}
   if(p==="unsubscribe"){for(const topic of m.topics.keys())m.topics.set(topic,"withdrawn");m.suppressed=true;invalidate(m);return {ok:true};}
   return {channel:m.channel,suppressed:m.suppressed,preferences:view(m),edit_token:issueToken(m,"edit")};
  },
  async edit(x){
   if(x.add.some(t=>!codes.has(t))||x.remove.some(t=>!codes.has(t))||(x.add.length&&(!x.adult||!x.consent)))return false;
   const t=take(x.token,"edit");if(!t||t.m.suppressed&&x.add.length)return false;
   for(const topic of x.remove)if(t.m.topics.has(topic))t.m.topics.set(topic,"withdrawn");
   for(const topic of x.add)t.m.topics.set(topic,"active");
   invalidate(t.m);return true;
  }
 };
}
