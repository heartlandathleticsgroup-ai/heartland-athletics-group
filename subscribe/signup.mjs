import {TOPICS,CONSENT,CONSENT_VERSION,NOTICE_VERSION,validateRequest} from '../release/subscribers/consent.mjs';
const ENABLED=false; // Only flip after legal review and hosted signup acceptance.
const API='https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/hag-email-signup';
const $=id=>document.getElementById(id);
$('wording').textContent=CONSENT.email;
for(const [code,title] of TOPICS){const label=document.createElement('label');label.className='check';const box=document.createElement('input');box.type='checkbox';box.name='topic';box.value=code;label.append(box,document.createTextNode(' '+title));$('topics').append(label)}
if(ENABLED){$('adult').disabled=false;$('availability').textContent='Email enrollment is available. Text enrollment is not open.'}
$('adult').addEventListener('change',()=>{const open=ENABLED&&$('adult').checked;$('email-panel').hidden=!open;$('email-panel').disabled=!open;$('submit').disabled=!open;if(!open){$('name').value='';$('email').value='';$('consent').checked=false;$('terms').checked=false;for(const b of document.querySelectorAll('[name=topic]'))b.checked=false}});
let pending=false;
$('signup').addEventListener('submit',async e=>{
 e.preventDefault();if(!ENABLED||pending||!$('adult').checked)return;
 const form={name:$('name').value,adult:true,email:{enabled:true,destination:$('email').value,topics:[...document.querySelectorAll('[name=topic]:checked')].map(x=>x.value),consent:$('consent').checked},sms:{enabled:false,destination:'',topics:[],consent:false}};
 try{validateRequest(form);if(!$('terms').checked)throw Error()}catch{$('status').textContent='Please complete the required fields and choose at least one topic.';return}
 pending=true;$('submit').disabled=true;
 try{
 const res=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000),body:JSON.stringify({requestId:crypto.randomUUID(),notice:NOTICE_VERSION,version:CONSENT_VERSION,terms:true,form})});
 const data=await res.json();if(res.status!==202||data.ok!==true)throw Error();
 $('signup').reset();$('email-panel').hidden=true;$('email-panel').disabled=true;$('status').textContent='Request received. Eligible selections take effect without a confirmation email. If you previously unsubscribed, contact H.A.G. about rejoining.';
 }catch{$('status').textContent='Unable to complete your request right now. Please try again later or contact H.A.G.'}
 finally{pending=false;$('submit').disabled=!$('adult').checked}
});
