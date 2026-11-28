export const BASE='https://unrqbfngcgvqnytxbtgj.supabase.co', KEY='sb_publishable_JeTzqF2gS0-pEHLs3VLOmg_GmK22bon';
export const FEATURE_EVENT='8b110000-0000-4000-8000-000000000001';
export const DOT='8b110000-0000-4000-8000-000000000002';
export const DRY='8b110000-0000-4000-8000-000000000003';
export const LOGO_SIZES=Object.freeze(['compact','standard','large','premier']);
export function logoSize(v){return LOGO_SIZES.includes(v)?v:'standard'}
export function sponsorPriority(a,b){return LOGO_SIZES.indexOf(logoSize(b.logo_size))-LOGO_SIZES.indexOf(logoSize(a.logo_size))||a.title.localeCompare(b.title)}
export function mediaId(v){return typeof v==='string'&&/^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)?v.slice(6):null}
export function safeLink(v){try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}}
export function safeImage(v){return typeof v==='string'&&/^\/assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|avif|gif)$/.test(v)&&!/(^|\/)\.\.?(\/|$)|\/\//.test(v)?v:null}
export function raster(v){return v&&['image/jpeg','image/png','image/webp'].includes(v.mime)&&typeof v.payload==='string'&&v.payload.length<=546136&&/^[A-Za-z0-9+/]+={0,2}$/.test(v.payload)?'data:'+v.mime+';base64,'+v.payload:null}
export function formatDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return '';const d=new Date(s+'T12:00:00Z');return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(d)}
export function eventDate(c){return [formatDate(c.date),c.end_date&&c.end_date!==c.date?formatDate(c.end_date):''].filter(Boolean).join(' – ')}
// Restricted text formatting: paragraphs, heading lines, bullets and **bold**. No HTML interpretation.
export function formatBody(doc,value){
 const root=doc.createElement('div');root.className='cms-copy';let list=null;
 const inline=(n,s)=>{for(const [i,t] of String(s).split(/\*\*([^*\n]+)\*\*/g).entries()){if(i%2){const b=doc.createElement('strong');b.textContent=t;n.append(b)}else n.append(doc.createTextNode(t))}};
 for(const line of String(value||'').split(/\r?\n/)){if(!line.trim()){list=null;continue}if(line.startsWith('- ')){if(!list){list=doc.createElement('ul');root.append(list)}const li=doc.createElement('li');inline(li,line.slice(2));list.append(li)}else{list=null;const el=doc.createElement(line.startsWith('## ')?'h4':'p');inline(el,line.startsWith('## ')?line.slice(3):line);root.append(el)}}return root;
}
export function imageNode(doc,c,kind,resolve){
 const local=safeImage(c.image), id=mediaId(c.image);if(!local&&!id)return null;
 const img=doc.createElement('img');img.alt=kind==='sponsor'?c.title+' logo':c.title;img.loading='lazy';img.decoding='async';img.className='cms-image';
 if(local)img.src=local;
 else{let started=false;const start=()=>{if(started)return;started=true;void Promise.resolve(resolve(id)).then(v=>{const src=raster(v);if(src&&img.isConnected)img.src=src}).catch(()=>{});};if(typeof IntersectionObserver==='function'){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();start()}},{rootMargin:'200px'});observer.observe(img)}else queueMicrotask(start)}
 return img;
}
export function card(doc,c,kind,resolve){
 const a=doc.createElement('article');a.className='cms-public-card cms-'+kind;if(kind==='sponsor')a.dataset.logoSize=logoSize(c.logo_size);
 const img=imageNode(doc,c,kind,resolve);if(img)a.append(img);
 const content=doc.createElement('div');content.className='cms-card-copy';
 const badge=doc.createElement('span');badge.className='cms-card-label';badge.textContent=kind==='news'?'H.A.G. news':kind==='event'?'Upcoming event':'Community partner';content.append(badge);
 const title=doc.createElement('h3');title.textContent=c.title;content.append(title);
 if(kind==='event'){const date=doc.createElement('p');date.className='cms-date';date.textContent=[eventDate(c),c.location].filter(Boolean).join(' • ');content.append(date)}
 content.append(formatBody(doc,c.body));
 const url=safeLink(c.url);if(url){const link=doc.createElement('a');link.href=url;link.className='cms-read-link';link.textContent=kind==='event'?'Event details':kind==='sponsor'?'Visit website':'Read more';link.rel='noopener noreferrer';content.append(link)}
 a.append(content);return a;
}
