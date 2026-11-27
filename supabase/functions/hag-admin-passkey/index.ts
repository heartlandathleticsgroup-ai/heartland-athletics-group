import {ORIGIN,verifiedPasskey} from "./verify.mjs";
const BASE="https://unrqbfngcgvqnytxbtgj.supabase.co";
const cors={"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"apikey, content-type, authorization, x-client-info","Vary":"Origin","Cache-Control":"no-store","Content-Type":"application/json"};
const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:cors});
Deno.serve(async req=>{
 if(req.headers.get("Origin")!==ORIGIN)return reply(403,{error:"Unavailable"});
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 if(req.method!=="POST")return reply(405,{error:"Unavailable"});
 try{
  if(!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))return reply(415,{error:"Unavailable"});
  const reader=req.body?.getReader();if(!reader)return reply(400,{error:"Unavailable"});
  let size=0;const chunks:Uint8Array[]=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return reply(413,{error:"Unavailable"});}chunks.push(value);}
  const body=new Uint8Array(size);let offset=0;for(const c of chunks){body.set(c,offset);offset+=c.length;}
  const anon=Deno.env.get("SUPABASE_ANON_KEY"),service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(Deno.env.get("SUPABASE_URL")!==BASE||!anon||!service)return reply(503,{error:"Unavailable"});
  const input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
  const tokens=await verifiedPasskey(input,{base:BASE,anon,service});
  return reply(200,tokens);
 }catch{return reply(401,{error:"Passkey sign-in unavailable. Use password and authenticator."});}
});
