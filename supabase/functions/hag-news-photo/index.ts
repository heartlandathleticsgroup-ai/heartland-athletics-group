import { createClient } from "npm:@supabase/supabase-js@2";
const origins=new Set(["https://heartlandathleticsgroup.com","https://www.heartlandathleticsgroup.com"]);
function reply(origin:string,body:unknown,status=200){
 return new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json","cache-control":"no-store",
 "access-control-allow-origin":origins.has(origin)?origin:"https://heartlandathleticsgroup.com",
 "access-control-allow-methods":"POST,OPTIONS",
 "access-control-allow-headers":"authorization,apikey,content-type,x-client-info",
 "vary":"Origin"}});
}
Deno.serve(async req=>{
 const origin=req.headers.get("origin")||"";
 if(req.method==="OPTIONS")return reply(origin,{ok:true});
 if(req.method!=="POST"||!origins.has(origin))return reply(origin,{error:"Request not permitted"},403);
 const bearer=req.headers.get("authorization")||"";
 if(!bearer.startsWith("Bearer "))return reply(origin,{error:"Administrator authentication required"},401);
 const base=Deno.env.get("SUPABASE_URL")||"";
 const publishable=Deno.env.get("SUPABASE_ANON_KEY")||"";
 const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!serviceKey)return reply(origin,{error:"Server image publishing is not configured; contact the H.A.G. project owner."},503);
 const staff=createClient(base,publishable,{global:{headers:{Authorization:bearer}},auth:{persistSession:false}});
 const {data:me,error:authError}=await staff.auth.getUser(bearer.slice(7));
 if(authError||!me?.user?.email_confirmed_at)return reply(origin,{error:"Verified administrator session required"},401);
 const {data:member,error:memberError}=await staff.from("hag_staff").select("role,active").eq("user_id",me.user.id).maybeSingle();
 if(memberError||!member?.active||member.role!=="admin")return reply(origin,{error:"Administrator permission required"},403);
 let payload:any;
 try{payload=await req.json()}catch{return reply(origin,{error:"Invalid request"},400)}
 const id=typeof payload?.articleId==="string"?payload.articleId:"";
 const action=payload?.action;
 if(!/^[0-9a-f-]{36}$/i.test(id)||!["publish","remove","archive"].includes(action))
  return reply(origin,{error:"Invalid article or action"},400);
 const admin=createClient(base,serviceKey,{auth:{autoRefreshToken:false,persistSession:false}});
 const {data:article,error:fetchError}=await admin.from("hag_articles")
  .select("id,status,published_at,hero_image_private_path,hero_image_public_path,hero_image_rights_confirmed,hero_image_alt,hero_image_caption,hero_image_credit")
  .eq("id",id).single();
 if(fetchError||!article)return reply(origin,{error:"News article not found"},404);
 const oldPath=article.hero_image_public_path;
 if(action==="remove"||action==="archive"){
  if(oldPath){
   const removed=await admin.storage.from("hag-news-public").remove([oldPath]);
   if(removed.error)return reply(origin,{error:"Could not remove the public image. Nothing was changed."},502);
  }
  const update:any={hero_image_url:null,hero_image_public_path:null,updated_at:new Date().toISOString(),updated_by:me.user.id};
  if(action==="archive")update.status="archived";
  const {error}=await admin.from("hag_articles").update(update).eq("id",id);
  if(error)return reply(origin,{error:"Image removed but article record could not be updated; contact your administrator."},500);
  return reply(origin,{ok:true,message:action==="archive"?"Article archived and public photo removed.":"Public photo removed. Private source retained for staff."});
 }
 if(article.status!=="published"||!article.published_at||new Date(article.published_at).getTime()>Date.now())
  return reply(origin,{error:"The article must be publicly published before its photograph can be released."},409);
 if(!article.hero_image_rights_confirmed||!article.hero_image_alt||article.hero_image_alt.trim().length<8)
  return reply(origin,{error:"Photo rights/guardian consent and descriptive alternative text must be confirmed first."},422);
 const source=article.hero_image_private_path;
 const pathPattern=/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/i;
 if(typeof source!=="string"||!pathPattern.test(source))return reply(origin,{error:"Attach a valid private news photo before publishing."},422);
 const suffix=(source.match(/\.(jpg|jpeg|png|webp)$/i)||[])[1]?.toLowerCase();
 const contentType=({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp"} as Record<string,string>)[suffix]||"";
 const {data:blob,error:downloadError}=await admin.storage.from("hag-news-drafts").download(source);
 if(downloadError||!blob)return reply(origin,{error:"Private photo missing or inaccessible"},404);
 if(blob.size>6291456||blob.size<100||!contentType)
  return reply(origin,{error:"Photo must be a valid supported image under 6 MB"},422);
 const destination=id+"/hero-"+crypto.randomUUID()+"."+suffix;
 const upload=await admin.storage.from("hag-news-public").upload(destination,blob,{contentType,upsert:false,cacheControl:"3600"});
 if(upload.error)return reply(origin,{error:"Unable to publish the photo"},502);
 const publicUrl=admin.storage.from("hag-news-public").getPublicUrl(destination).data.publicUrl;
 const {error:updateError}=await admin.from("hag_articles")
  .update({hero_image_url:publicUrl,hero_image_public_path:destination,
   updated_by:me.user.id,updated_at:new Date().toISOString()}).eq("id",id);
 if(updateError){
   await admin.storage.from("hag-news-public").remove([destination]);
   return reply(origin,{error:"Photo uploaded but could not attach to article"},500);
 }
 if(oldPath&&oldPath!==destination)await admin.storage.from("hag-news-public").remove([oldPath]);
 return reply(origin,{ok:true,photoUrl:publicUrl,message:"Approved photograph is now public with the article."});
});
