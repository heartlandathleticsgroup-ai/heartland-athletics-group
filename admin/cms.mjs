// Uses the existing verified admin session. No new credentials or local draft storage.
import {card,raster,mediaId,logoSize} from '../assets/js/cms-render.mjs?v=3';
import {prepareImage} from './cms-image.mjs';
export const KINDS=['news','event','sponsor'];
export const stateOf=r=>r.published_revision==null?'Draft':r.published_revision===r.revision?'Published':'Unpublished edits';
export function draftFrom(values,kind){
 return {title:String(values.title||'').trim(),body:String(values.body||'').trim(),url:String(values.url||'').trim(),image:String(values.image||'').trim(),date:kind==='event'?String(values.date||''):'',location:kind==='event'?String(values.location||'').trim():'',end_date:kind==='event'?String(values.end_date||''):'',scope:kind==='sponsor'?String(values.scope||'general'):'general',logo_size:kind==='sponsor'?logoSize(values.logo_size):'standard',permission:kind==='sponsor'&&values.permission===true};
}
export function attachCMS(root,rpc,allowed){
 const doc=root.ownerDocument; let rows=[],media=[],generation=0,busy=false,loaded=false;const imageCache=new Map();
 const panels={}; const status=root.querySelector('[data-cms-status]');
 const make=(tag,txt)=>{const n=doc.createElement(tag);if(txt!=null)n.textContent=txt;return n};
 const action=(label,fn)=>{const b=make('button',label);b.type='button';b.className='secondary';b.addEventListener('click',fn);return b};
 const notify=t=>{if(status)status.textContent=t};
 const enabled=()=>allowed()&&!root.hidden;
 const mediaHost=root.querySelector('[data-cms-media-library]');let mediaList,mediaStatus,libraryFile,libraryLabel;
 const values=p=>Object.fromEntries(Object.entries(p.inputs).map(([name,x])=>[name,x.type==='checkbox'?x.checked:x.value]));
 async function resolve(id){if(!enabled())throw Error('Locked');const epoch=generation;if(!imageCache.has(id))imageCache.set(id,Promise.resolve(rpc('hag_cms_media_get',{p_id:id})).catch(e=>{imageCache.delete(id);throw e}));const v=await imageCache.get(id);if(epoch!==generation||!enabled())throw Error('Locked');return v;}
 function preview(k){const p=panels[k];if(!p)return;const c=draftFrom(values(p),k);p.preview.replaceChildren(card(doc,{...c,title:c.title||'Untitled '+k},k,resolve));}
 function mediaOptions(){for(const [k,p] of Object.entries(panels)){if(!p.mediaSelect)continue;const opts=[new Option('Choose a library image…',''),...media.map(m=>new Option(m.label,'media:'+m.id))];p.mediaSelect.replaceChildren(...opts);p.mediaSelect.value=mediaId(p.inputs.image.value)?p.inputs.image.value:'';} }
 function renderMedia(){mediaOptions();if(!mediaList)return;mediaList.replaceChildren();mediaStatus.textContent=media.length+' / 100 images · private until published';for(const m of media){const row=make('article');row.className='cms-record';row.append(make('strong',m.label));const thumb=make('div');thumb.className='cms-media-thumb';const view=action('Preview',async()=>{try{const src=raster(await resolve(m.id));if(src&&enabled()&&thumb.isConnected){const img=make('img');img.src=src;img.alt=m.label;thumb.replaceChildren(img)}}catch{notify('Preview unavailable.')}});const remove=action('Remove unused image',()=>{if(globalThis.confirm('Delete this image? Images used by saved drafts or publications cannot be removed.'))void perform(async valid=>{const result=await rpc('hag_cms_media_remove',{p_id:m.id});if(!valid())return;if(result!==true)throw Error('Removal failed');media=media.filter(x=>x.id!==m.id);imageCache.delete(m.id);renderMedia();notify('Unused image removed.');})});row.append(thumb,view,remove);mediaList.append(row);} }
 async function upload(file,label,k){await perform(async valid=>{notify('Preparing image…');const prepared=await prepareImage(file,doc);if(!valid())return;notify('Uploading compressed image…');const m=await rpc('hag_cms_media_add',{p_label:label||file.name.slice(0,140),p_mime:prepared.mime,p_payload:prepared.payload});if(!valid())return;if(!m?.id)throw Error('Upload failed');media=[m,...media];imageCache.set(m.id,Promise.resolve({id:m.id,...prepared}));renderMedia();if(k){const p=panels[k];p.inputs.image.value='media:'+m.id;p.mediaSelect.value=p.inputs.image.value;p.dirty=true;preview(k);}notify('Image added to private media library. Save and publish an entry to make it public.');});}
 function render(){
  for(const [k,p] of Object.entries(panels)){
   p.list.replaceChildren();
   for(const r of rows.filter(x=>x.kind===k)){
    const card=make('article');card.className='cms-record';card.append(make('strong',r.draft.title),make('p',stateOf(r)));if(r.draft.body)card.append(make('p',r.draft.body));if(r.kind==='event')card.append(make('p',[r.draft.date,r.draft.location].filter(Boolean).join(' · ')));
    const buttons=make('div');buttons.className='cms-actions';
    buttons.append(action('Edit draft',()=>edit(k,r)),action('Publish saved draft',()=>{if(p.dirty&&p.current?.id===r.id){p.message.textContent='Save or discard your edits before publishing.';return}if(globalThis.confirm('Publish this saved draft to the H.A.G. website?'))void change(k,'publish',r,null)}));
    if(r.published_revision!=null)buttons.append(action('Unpublish',()=>{if(globalThis.confirm('Remove this item from the CMS public feed?'))void change(k,'unpublish',r,null)}));
    card.append(buttons);p.list.append(card);
   }
   if(loaded&&!rows.some(x=>x.kind===k))p.list.append(make('p','No CMS entries yet.'));
  }
  for(const k of KINDS){const n=root.querySelector('[data-cms-count="'+k+'"]');if(n)n.textContent=loaded?String(rows.filter(x=>x.kind===k&&x.published_revision!=null).length):'—';}
  const d=root.querySelector('[data-cms-drafts]');if(d)d.textContent=loaded?String(rows.filter(x=>x.published_revision!==x.revision).length):'—';
 }
 function edit(k,r=null,force=false){
  if((!enabled()||busy)&&!force)return;
  const p=panels[k];if(p.dirty&&!force&&!globalThis.confirm('Discard unsaved edits?'))return;
  p.current=r;p.dirty=false;p.form.reset();p.heading.textContent=r?'Edit draft':'New '+k;
  for(const [name,input] of Object.entries(p.inputs)){if(input.type==='checkbox')input.checked=!!r?.draft[name];else input.value=r?.draft[name]||(name==='scope'?'general':name==='logo_size'?'standard':'');}
  p.message.textContent='';p.form.hidden=false;mediaOptions();preview(k);
 }
 async function perform(fn){
  if(!enabled()||busy)return;busy=true;const epoch=generation;
  for(const p of Object.values(panels))for(const input of Object.values(p.inputs))input.disabled=true;
  try{await fn(()=>epoch===generation&&enabled());}catch{if(epoch===generation&&enabled()){notify('CMS request failed. Check your session, field values or sponsor permission and refresh. No success has been assumed.');for(const p of Object.values(panels))if(p.message.textContent==='Working…')p.message.textContent='Request failed. Review status above.';}}
  finally{if(epoch===generation){busy=false;for(const p of Object.values(panels))for(const input of Object.values(p.inputs))input.disabled=false;}}
 }
 async function refresh(){await perform(async valid=>{notify('Loading content…');const value=await rpc('hag_cms_list',{});if(!valid())return;if(!Array.isArray(value))throw Error('Invalid response');rows=value;loaded=true;render();for(const k of KINDS)preview(k);const library=await rpc('hag_cms_media_list',{});if(!valid())return;if(!Array.isArray(library))throw Error('Invalid library');media=library;renderMedia();notify('Content loaded.');});}
 async function change(k,a,r,d){await perform(async valid=>{const p=panels[k];p.message.textContent='Working…';const value=await rpc('hag_cms_change',{p_action:a,p_kind:k,p_id:r?.id||null,p_revision:r?.revision||0,p_draft:d});if(!valid())return;if(!value?.id||value.kind!==k)throw Error('Invalid response');rows=[value,...rows.filter(x=>x.id!==value.id)];loaded=true;if(a==='save')edit(k,value,true);else if(p.current?.id===value.id&&!p.dirty)edit(k,value,true);render();p.message.textContent=a==='save'?'Draft saved. Not published.':a==='publish'?'Published to CMS feed.':'Unpublished.';notify('Content updated.');});}
 for(const k of KINDS){
  const host=root.querySelector('[data-cms-kind="'+k+'"]');if(!host)continue;
  const heading=make('h4','New '+k),form=make('form'),message=make('p'),list=make('div'),inputs={};
  form.className='cms-form';message.setAttribute('role','status');list.className='cms-list';
  const fields=[['title',k==='sponsor'?'Sponsor name':'Title','text',140],['body',k==='sponsor'?'Public recognition text':'Description / announcement','textarea',4000],['url','Optional HTTPS website or registration link','url',500],['image','Image reference (library selection or existing /assets/ path)','text',300]];
  if(k==='event')fields.push(['date','Event date','date',10],['end_date','End date (optional)','date',10],['location','Public venue / location','text',200]);
  if(k==='sponsor')fields.push(['scope','Recognition placement','select',0],['logo_size','Logo display size (not a public sponsorship tier)','select',0],['permission','I have permission to publish this sponsor name and logo','checkbox',0]);
  for(const [name,label,type,max] of fields){const wrap=make('label',label);const input=make(type==='textarea'?'textarea':type==='select'?'select':'input');if(type==='select'){for(const [v,t] of (name==='logo_size'?[['compact','Compact'],['standard','Standard'],['large','Large'],['premier','Extra large']]:[['general','General H.A.G. recognition'],['gus-macker','Gus Macker sponsor directory'],['gus-macker-featured','Gus Macker featured + directory']]))input.append(new Option(t,v));}else if(type!=='textarea')input.type=type;input.name=name;if(max)input.maxLength=max;if(name==='title'||name==='date')input.required=true;wrap.append(input);form.append(wrap);inputs[name]=input;}
  const mediaSelect=make('select');mediaSelect.setAttribute('aria-label','Select library image');
  const imageFile=make('input');imageFile.type='file';imageFile.accept='image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif';imageFile.setAttribute('aria-label','Upload image');
  const tools=make('div');tools.className='cms-editor-tools';
  const formatting=make('div');formatting.className='cms-actions';
  function insertFormat(before,after=''){if(!enabled()||busy)return;const t=inputs.body;const a=t.selectionStart||0,b=t.selectionEnd||a;const selected=t.value.slice(a,b)||'Text';const next=t.value.slice(0,a)+before+selected+after+t.value.slice(b);if(next.length>4000)return;t.value=next;t.focus();t.setSelectionRange(a+before.length,a+before.length+selected.length);panels[k].dirty=true;preview(k);}
  formatting.append(action('Bold',()=>insertFormat('**','**')),action('Heading',()=>insertFormat('\n## ','\n')),action('Bullet',()=>insertFormat('\n- ','\n')));
  tools.append(make('strong','Formatting'),formatting,make('p','Choose text, then Bold, Heading or Bullet. The live preview shows the public formatting.'),make('strong','Media library'),mediaSelect,imageFile,action('Upload and select',()=>{const f=imageFile.files?.[0];if(f)void upload(f,f.name.slice(0,140),k);imageFile.value='';}),action('Clear image',()=>{if(!enabled()||busy)return;inputs.image.value='';mediaSelect.value='';panels[k].dirty=true;preview(k);}));
  const pv=make('div');pv.className='cms-preview';form.append(tools,make('h4','Live public-card preview'),pv);
  const save=make('button','Save draft');save.type='submit';save.className='gold';form.append(save);
  const p=panels[k]={heading,form,message,list,inputs,mediaSelect,imageFile,preview:pv,current:null,dirty:false};
  form.addEventListener('input',()=>{p.dirty=true;preview(k)});mediaSelect.addEventListener('change',()=>{if(!enabled()||busy)return;inputs.image.value=mediaSelect.value;p.dirty=true;preview(k)});
  form.addEventListener('submit',ev=>{ev.preventDefault();if(!enabled())return;const v=Object.fromEntries(Object.entries(inputs).map(([name,x])=>[name,x.type==='checkbox'?x.checked:x.value]));void change(k,'save',p.current,draftFrom(v,k));});
  const buttons=make('div');buttons.className='cms-actions';buttons.append(action('Refresh content',()=>void refresh()),action('New '+k,()=>edit(k)));
  host.append(buttons,heading,form,message,make('h4','Saved entries'),list);preview(k);
 }
 if(mediaHost){libraryFile=make('input');libraryFile.type='file';libraryFile.accept='image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif';libraryFile.setAttribute('aria-label','Choose image');libraryLabel=make('input');libraryLabel.maxLength=140;libraryLabel.placeholder='Image label (optional)';libraryLabel.setAttribute('aria-label','Image label');mediaStatus=make('p');mediaList=make('div');mediaList.className='cms-list';mediaHost.append(make('p','Upload photos, flyers and logos. Images are re-encoded to remove original metadata. Only publish images you have permission to use.'),libraryFile,libraryLabel,action('Upload to library',()=>{const f=libraryFile.files?.[0];if(f)void upload(f,libraryLabel.value.trim(),null);libraryFile.value='';libraryLabel.value='';}),action('Refresh library',()=>void refresh()),mediaStatus,mediaList);renderMedia();}
 root.querySelectorAll('[data-cms-open]').forEach(b=>b.addEventListener('click',()=>{if(enabled())root.querySelector('[data-module="'+b.dataset.cmsOpen+'"]')?.click()}));
 root.querySelectorAll('[data-cms-refresh]').forEach(b=>b.addEventListener('click',()=>void refresh()));
 function clear(){generation++;busy=false;rows=[];media=[];imageCache.clear();loaded=false;if(libraryFile)libraryFile.value='';if(libraryLabel)libraryLabel.value='';for(const p of Object.values(panels)){p.current=null;p.dirty=false;p.form.reset();p.imageFile.value='';p.preview.replaceChildren();for(const input of Object.values(p.inputs))input.disabled=false;p.heading.textContent='New entry';p.message.textContent='';}render();renderMedia();notify('Content not loaded.');}
 return {clear,refresh};
}
