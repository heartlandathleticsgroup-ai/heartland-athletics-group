import {BASE,KEY,FEATURE_EVENT,DOT,DRY,card,eventDate,formatBody,imageNode,safeLink,safeImage} from './cms-render.mjs';
export {safeImage,safeLink};
export function groupRows(rows){const out={news:[],event:[],sponsor:[]};for(const r of Array.isArray(rows)?rows:[]){if(!Object.hasOwn(out,r?.kind)||typeof r.content?.title!=='string')continue;out[r.kind].push({...r.content,id:r.id})}out.event.sort((a,b)=>String(a.date).localeCompare(String(b.date)));return out}
const request=async(fetcher,path)=>{const res=await fetcher(BASE+'/rest/v1/'+path,{headers:{apikey:KEY},credentials:'omit',signal:AbortSignal.timeout(6000)});if(!res.ok)throw Error('Unavailable');return res.json()};
export async function loadPublic(root,fetcher=globalThis.fetch){
 try{
  const rows=await request(fetcher,'hag_cms_publications?select=id,kind,content&order=published_at.desc&limit=600');if(!Array.isArray(rows))return;
  const groups=groupRows(rows),doc=root.ownerDocument||root;const resolve=async id=>(await request(fetcher,'hag_cms_media?select=mime,payload&id=eq.'+encodeURIComponent(id)))[0];
  const feature=groups.event.find(x=>x.id===FEATURE_EVENT);
  for(const section of doc.querySelectorAll('[data-cms-feature-event]')){
   if(!feature){if(section.id==='gus-macker-return')section.hidden=true;continue}
   const heading=section.querySelector('[data-cms-event-title]');if(heading)heading.textContent=feature.title;
   const date=section.querySelector('[data-cms-event-date]');if(date)date.textContent=[eventDate(feature),feature.location].filter(Boolean).join(' • ');
   const copy=section.querySelector('[data-cms-event-body]');if(copy)copy.replaceChildren(formatBody(doc,feature.body));
   const link=section.querySelector('[data-cms-event-link]');if(link){const url=safeLink(feature.url);if(url)link.href=url;else link.hidden=true;}
  }
  const eventSponsors=groups.sponsor.filter(x=>x.scope==='gus-macker'||x.scope==='gus-macker-featured');
  for(const host of doc.querySelectorAll('[data-cms-sponsor-list]')){
   const featured=host.dataset.cmsSponsorList==='featured';
   let items=featured?eventSponsors.filter(x=>x.scope==='gus-macker-featured'):eventSponsors;
   items=items.slice().sort((a,b)=>featured?((a.id===DOT?0:a.id===DRY?1:2)-(b.id===DOT?0:b.id===DRY?1:2)||a.title.localeCompare(b.title)):a.title.localeCompare(b.title));
   const nodes=items.map(c=>{const url=safeLink(c.url),n=doc.createElement(url?'a':'div');if(url){n.href=url;n.target='_blank';n.rel='noopener noreferrer'}n.className=featured?'macker-sponsor-card '+(c.id===DOT?'macker-sponsor-card-featured':'macker-sponsor-card-major'):'macker-sponsor-directory-card';const img=imageNode(doc,c,'sponsor',resolve);if(img)n.append(img);const title=doc.createElement('strong');title.textContent=c.title;n.append(title);if(featured&&c.body){const span=doc.createElement('span');span.textContent=c.body;n.append(span)}return n});
   host.replaceChildren(...nodes);host.hidden=!nodes.length;
  }
  const feed=doc.querySelector('[data-hag-public-cms]');if(!feed)return;
  groups.event=groups.event.filter(x=>x.id!==FEATURE_EVENT);
  groups.sponsor=groups.sponsor.filter(x=>!['gus-macker','gus-macker-featured'].includes(x.scope));
  for(const [kind,items] of Object.entries(groups)){const section=feed.querySelector('[data-public-cms="'+kind+'"]');if(!section)continue;const list=section.querySelector('[data-cms-list]');list.replaceChildren(...items.map(c=>card(doc,c,kind,resolve)));section.hidden=!items.length;}
  feed.hidden=!Object.values(groups).some(a=>a.length);
 }catch{/* Static fallback remains available if the public API is unavailable. */}
}
if(typeof document!=='undefined')void loadPublic(document);
