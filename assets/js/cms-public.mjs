// Additive, fail-closed public feed. Existing static website remains visible.
const BASE='https://unrqbfngcgvqnytxbtgj.supabase.co',KEY='sb_publishable_JeTzqF2gS0-pEHLs3VLOmg_GmK22bon';
export function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}}
export function safeImage(value){return typeof value==='string'&&/^\/assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|avif|gif)$/.test(value)&&!/(^|\/)\.\.?(\/|$)|\/\//.test(value)?value:null}
export function groupRows(rows){const out={news:[],event:[],sponsor:[]};for(const r of Array.isArray(rows)?rows:[]){if(!Object.hasOwn(out,r?.kind)||typeof r.content?.title!=='string')continue;out[r.kind].push(r.content)}out.event.sort((a,b)=>String(a.date).localeCompare(String(b.date)));return out}
export async function loadPublic(root,fetcher=globalThis.fetch){
 try{
  const res=await fetcher(BASE+'/rest/v1/hag_cms_publications?select=kind,content&order=published_at.desc&limit=600',{headers:{apikey:KEY},credentials:'omit',signal:AbortSignal.timeout(5000)});
  if(!res.ok)return;const groups=groupRows(await res.json());const doc=root.ownerDocument;
  for(const [kind,items] of Object.entries(groups)){const section=root.querySelector('[data-public-cms="'+kind+'"]');if(!section||!items.length)continue;const list=section.querySelector('[data-cms-list]');
   for(const c of items){const a=doc.createElement('article');a.className='cms-public-card';const title=doc.createElement('h3');title.textContent=c.title;a.append(title);
    const src=safeImage(c.image);if(src){const img=doc.createElement('img');img.src=src;img.alt=kind==='sponsor'?c.title+' logo':'';img.loading='lazy';a.append(img);}
    for(const text of [kind==='event'?[c.date,c.location].filter(Boolean).join(' · '):'',c.body])if(typeof text==='string'&&text){const p=doc.createElement('p');p.textContent=text;a.append(p)}
    const url=safeLink(c.url);if(url){const link=doc.createElement('a');link.href=url;link.textContent=kind==='event'?'Event details':kind==='sponsor'?'Visit website':'Read more';link.rel='noopener noreferrer';a.append(link)}
    list.append(a);
   }section.hidden=false;
  }if(Object.values(groups).some(a=>a.length))root.hidden=false;
 }catch{/* Static content stays available. */}
}
if(typeof document!=='undefined'){const root=document.querySelector('[data-hag-public-cms]');if(root)void loadPublic(root);}
