// Production-shaped HTTP boundary, unconnected. Only explicitly injected
// mock fetch is accepted during this phase. Never default to global fetch.
const TOKEN="https://oauth2.googleapis.com/token",REVOKE="https://oauth2.googleapis.com/revoke",SEND="https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const endpoints=new Set([TOKEN,REVOKE,SEND]);
const max=65536;
async function boundedJson(res){
 if(!res.body)return null;
 const reader=res.body.getReader();let total=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw Error("Response too large");chunks.push(value);}
 const buf=new Uint8Array(total);let offset=0;for(const c of chunks){buf.set(c,offset);offset+=c.length;}
 if(!total)return null;
 if(!/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type")||""))throw Error("Unexpected response type");
 return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buf));
 }finally{void reader.cancel().catch(()=>{});}
}
export function createGoogleHttpBoundary({mode,mockFetch}){
 if(mode!=="isolated-test"||typeof mockFetch!=="function"||mockFetch===globalThis.fetch)throw Error("Mock transport required");
 return async ({url,method,headers,body})=>{
  if(!endpoints.has(url)||method!=="POST"||typeof body!=="string"||body.length>max)throw Error("Transport request denied");
  const h=new Headers(headers);const send=url===SEND;
  if(send){if(h.get("content-type")!=="application/json"||!/^Bearer fixture-[A-Za-z0-9_-]{8,200}$/.test(h.get("authorization")||""))throw Error("Transport request denied");const obj=JSON.parse(body);if(Object.keys(obj).length!==1||typeof obj.raw!=="string"||!/^[A-Za-z0-9_-]+$/.test(obj.raw))throw Error("Transport request denied");
   const raw=Buffer.from(obj.raw,"base64url").toString("utf8");if(!/^To: [a-z0-9._+%-]+@[a-z0-9.-]+\.invalid\r?$/im.test(raw)||/^(?:Bcc|Cc|Resent-To):/im.test(raw))throw Error("Synthetic recipient required");
  }else{
   if(h.get("authorization")||h.get("content-type")!=="application/x-www-form-urlencoded")throw Error("Transport request denied");
   const p=new URLSearchParams(body),keys=[...p.keys()];if(new Set(keys).size!==keys.length)throw Error("Transport request denied");
   if(url===REVOKE){if(keys.length!==1||!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(p.get("token")||""))throw Error("Synthetic token required");}
   else{const grant=p.get("grant_type"),allowed=grant==="authorization_code"?["client_id","client_secret","grant_type","code","redirect_uri","code_verifier"]:grant==="refresh_token"?["client_id","client_secret","grant_type","refresh_token"]:[];if(keys.length!==allowed.length||keys.some(k=>!allowed.includes(k))||p.get("client_id")!=="fixture.apps.googleusercontent.com"||!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(p.get("client_secret")||""))throw Error("Synthetic grant required");
    if(grant==="authorization_code"&&(p.get("redirect_uri")!=="https://preview.invalid/oauth/gmail/callback"||!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(p.get("code")||"")||!/^[A-Za-z0-9_-]{43}$/.test(p.get("code_verifier")||"")))throw Error("Synthetic grant required");
    if(grant==="refresh_token"&&!/^fixture-[A-Za-z0-9_-]{8,200}$/.test(p.get("refresh_token")||""))throw Error("Synthetic grant required");
   }
  }
  // No redirects, credentials/cookies, retry, cache, referrer or exception detail.
  const controller=new AbortController();let timer;
  try{
   const task=(async()=>{const res=await mockFetch(url,{method:"POST",headers:h,body,redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer",signal:controller.signal});if(res.redirected||res.status>=300&&res.status<400)throw Error("Redirect denied");return {status:res.status,body:await boundedJson(res)};})();
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error("Transport unavailable"));},5000);});
   return await Promise.race([task,timeout]);
  }catch{throw Error("Google transport unavailable");}finally{clearTimeout(timer);}
 };
}
