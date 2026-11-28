// Re-encode images in the browser; no original metadata or SVG is stored.
export const MAX_IMAGE_BYTES=409600, MAX_SOURCE_BYTES=20*1024*1024;
export function imagePayload(data){
 const m=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data||'');
 if(!m)return null;
 const bytes=Math.floor(m[2].length*3/4)-(m[2].endsWith('==')?2:m[2].endsWith('=')?1:0);
 return bytes>0&&bytes<=MAX_IMAGE_BYTES?{mime:m[1],payload:m[2]}:null;
}
export async function prepareImage(file,doc=document){
 if(!file||!['image/jpeg','image/png','image/webp','image/avif','image/gif','image/heic','image/heif'].includes(file.type)||file.size>MAX_SOURCE_BYTES)throw Error('Choose a supported raster image below 20 MB');
 const data=await new Promise((ok,bad)=>{const f=new FileReader();f.onload=()=>ok(f.result);f.onerror=bad;f.readAsDataURL(file)});
 const img=await new Promise((ok,bad)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>bad(Error('This device cannot decode the image. Choose JPEG, PNG or WebP.'));i.src=data});
 if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>80000000)throw Error('Image dimensions too large');
 const canvas=doc.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');
 for(const limit of [1600,1280,1024,800,640]){
  const scale=Math.min(1,limit/Math.max(img.naturalWidth,img.naturalHeight));canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));ctx.drawImage(img,0,0,canvas.width,canvas.height);
  for(const q of [.88,.76,.64]){const out=imagePayload(canvas.toDataURL('image/webp',q));if(out)return out}
  const png=imagePayload(canvas.toDataURL('image/png'));if(png)return png;
  // JPEG fallback on devices lacking WebP encoding; flatten transparency against white.
  ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.globalCompositeOperation='source-over';
  for(const q of [.88,.76,.64]){const out=imagePayload(canvas.toDataURL('image/jpeg',q));if(out)return out}
 }
 throw Error('Image could not be compressed below 400 KB');
}
