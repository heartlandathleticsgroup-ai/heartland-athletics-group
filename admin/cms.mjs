// Uses the existing verified admin session. No new credentials or local draft storage.
export const KINDS=['news','event','sponsor'];
export const stateOf=r=>r.published_revision==null?'Draft':r.published_revision===r.revision?'Published':'Unpublished edits';
export function draftFrom(values,kind){
 return {title:String(values.title||'').trim(),body:String(values.body||'').trim(),url:String(values.url||'').trim(),image:String(values.image||'').trim(),date:kind==='event'?String(values.date||''):'',location:kind==='event'?String(values.location||'').trim():'',permission:kind==='sponsor'&&values.permission===true};
}
export function attachCMS(root,rpc,allowed){
 const doc=root.ownerDocument; let rows=[],generation=0,busy=false,loaded=false;
 const panels={}; const status=root.querySelector('[data-cms-status]');
 const make=(tag,txt)=>{const n=doc.createElement(tag);if(txt!=null)n.textContent=txt;return n};
 const action=(label,fn)=>{const b=make('button',label);b.type='button';b.className='secondary';b.addEventListener('click',fn);return b};
 const notify=t=>{if(status)status.textContent=t};
 const enabled=()=>allowed()&&!root.hidden;
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
  for(const [name,input] of Object.entries(p.inputs)){if(input.type==='checkbox')input.checked=!!r?.draft[name];else input.value=r?.draft[name]||'';}
  p.message.textContent='';p.form.hidden=false;
 }
 async function perform(fn){
  if(!enabled()||busy)return;busy=true;const epoch=generation;
  for(const p of Object.values(panels))for(const input of Object.values(p.inputs))input.disabled=true;
  try{await fn(()=>epoch===generation&&enabled());}catch{if(epoch===generation&&enabled()){notify('CMS request failed. Check your session, field values or sponsor permission and refresh. No success has been assumed.');for(const p of Object.values(panels))if(p.message.textContent==='Working…')p.message.textContent='Request failed. Review status above.';}}
  finally{if(epoch===generation){busy=false;for(const p of Object.values(panels))for(const input of Object.values(p.inputs))input.disabled=false;}}
 }
 async function refresh(){await perform(async valid=>{notify('Loading content…');const value=await rpc('hag_cms_list',{});if(!valid())return;if(!Array.isArray(value))throw Error('Invalid response');rows=value;loaded=true;render();notify('Content loaded.');});}
 async function change(k,a,r,d){await perform(async valid=>{const p=panels[k];p.message.textContent='Working…';const value=await rpc('hag_cms_change',{p_action:a,p_kind:k,p_id:r?.id||null,p_revision:r?.revision||0,p_draft:d});if(!valid())return;if(!value?.id||value.kind!==k)throw Error('Invalid response');rows=[value,...rows.filter(x=>x.id!==value.id)];loaded=true;if(a==='save')edit(k,value,true);else if(p.current?.id===value.id&&!p.dirty)edit(k,value,true);render();p.message.textContent=a==='save'?'Draft saved. Not published.':a==='publish'?'Published to CMS feed.':'Unpublished.';notify('Content updated.');});}
 for(const k of KINDS){
  const host=root.querySelector('[data-cms-kind="'+k+'"]');if(!host)continue;
  const heading=make('h4','New '+k),form=make('form'),message=make('p'),list=make('div'),inputs={};
  form.className='cms-form';message.setAttribute('role','status');list.className='cms-list';
  const fields=[['title',k==='sponsor'?'Sponsor name':'Title','text',140],['body',k==='sponsor'?'Public recognition text':'Description / announcement','textarea',4000],['url','Optional HTTPS website or registration link','url',500],['image','Optional existing /assets/ image path','text',300]];
  if(k==='event')fields.push(['date','Event date','date',10],['location','Public venue / location','text',200]);
  if(k==='sponsor')fields.push(['permission','I have permission to publish this sponsor name and logo','checkbox',0]);
  for(const [name,label,type,max] of fields){const wrap=make('label',label);const input=make(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.name=name;if(max)input.maxLength=max;if(name==='title'||name==='date')input.required=true;wrap.append(input);form.append(wrap);inputs[name]=input;}
  const save=make('button','Save draft');save.type='submit';save.className='gold';form.append(save);
  const p=panels[k]={heading,form,message,list,inputs,current:null,dirty:false};
  form.addEventListener('input',()=>{p.dirty=true});
  form.addEventListener('submit',ev=>{ev.preventDefault();if(!enabled())return;const v=Object.fromEntries(Object.entries(inputs).map(([name,x])=>[name,x.type==='checkbox'?x.checked:x.value]));void change(k,'save',p.current,draftFrom(v,k));});
  const buttons=make('div');buttons.className='cms-actions';buttons.append(action('Refresh content',()=>void refresh()),action('New '+k,()=>edit(k)));
  host.append(buttons,heading,form,message,make('h4','Saved entries'),list);
 }
 root.querySelectorAll('[data-cms-open]').forEach(b=>b.addEventListener('click',()=>{if(enabled())root.querySelector('[data-module="'+b.dataset.cmsOpen+'"]')?.click()}));
 root.querySelectorAll('[data-cms-refresh]').forEach(b=>b.addEventListener('click',()=>void refresh()));
 function clear(){generation++;busy=false;rows=[];loaded=false;for(const p of Object.values(panels)){p.current=null;p.dirty=false;p.form.reset();for(const input of Object.values(p.inputs))input.disabled=false;p.heading.textContent='New entry';p.message.textContent='';}render();notify('Content not loaded.');}
 return {clear,refresh};
}
