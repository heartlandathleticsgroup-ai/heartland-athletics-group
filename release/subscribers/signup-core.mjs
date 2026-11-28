import {CONSENT_VERSION,NOTICE_VERSION,validateRequest} from './consent.mjs';
import {validEmail} from './email-validation.mjs';
const ORIGIN='https://heartlandathleticsgroup.com';
const ROUTES=new Set(['/hag-email-signup','/functions/v1/hag-email-signup']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));
function reply(status,payload,cors=false){
 const h={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin','Content-Type':'application/json'};
 if(cors)h['Access-Control-Allow-Origin']=ORIGIN;
 if(status===204){h['Access-Control-Allow-Methods']='POST';h['Access-Control-Allow-Headers']='content-type';return new Response(null,{status,headers:h})}
 return new Response(JSON.stringify(payload),{status,headers:h});
}
async function readBody(req){
 if(!req.body||req.headers.has('content-encoding')||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))throw Error('body');
 const len=req.headers.get('content-length');if(len!==null&&(!/^\d+$/.test(len)||Number(len)>8192))throw Error('size');
 const reader=req.body.getReader(),chunks=[];let n=0,timer;
 try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),2000)});
 while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;n+=value.byteLength;if(n>8192)throw Error('size');chunks.push(value)}
 const bytes=new Uint8Array(n);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{})}
}
export function createSignup({enabled,db,now=Date.now}){
 let minute=-1,hits=0,busy=false;
 return async req=>{
  const origin=req.headers.get('origin')===ORIGIN;if(!origin)return reply(403,{ok:false});
  const u=new URL(req.url);if(!ROUTES.has(u.pathname)||u.search)return reply(400,{ok:false},true);
  if(req.method==='OPTIONS'&&req.headers.get('access-control-request-method')==='POST'&&/^(?:content-type)?$/i.test(req.headers.get('access-control-request-headers')||''))return reply(204,null,true);
  if(req.method!=='POST')return reply(405,{ok:false},true);
  if(!enabled||typeof db!=='function')return reply(503,{ok:false,disabled:true},true);
  const m=Math.floor(now()/60000);if(m!==minute){minute=m;hits=0}if(++hits>30||busy)return reply(429,{ok:false},true);
  let data;try{
   const x=await readBody(req);
   if(!exact(x,['requestId','notice','version','terms','form'])||!uuid.test(x.requestId)||x.notice!==NOTICE_VERSION||x.version!==CONSENT_VERSION||x.terms!==true)throw Error();
   const v=validateRequest(x.form);if(v.requests.length!==1||v.requests[0].channel!=='email'||!validEmail(v.requests[0].destination))throw Error();
   data={requestId:x.requestId,name:v.name,...v.requests[0]};
  }catch{return reply(400,{ok:false},true)}
  if(busy)return reply(429,{ok:false},true);
  busy=true;try{const ok=await db(data);if(ok!==true)return reply(503,{ok:false},true);
   return reply(202,{ok:true,message:'Request received. Eligible email selections take effect without a confirmation message.'},true);
  }catch{return reply(503,{ok:false},true)}finally{busy=false}
 };
}
