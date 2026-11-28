import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MODULES,selectModule,attachDashboard} from "../admin/dashboard.mjs";
const html=readFileSync(new URL("../admin/index.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../admin/dashboard.mjs",import.meta.url),"utf8");
assert.equal(MODULES.length,16);
assert.equal(new Set(MODULES).size,16);
assert.match(html,/<div id="authorized-panel" hidden>/);
assert.match(html,/auth\.js\?v=cms2/);
const dashboard=html.slice(html.indexOf('<div id="authorized-panel" hidden>'),html.indexOf('<button id="signout"'));
const buttons=MODULES.map(id=>({dataset:{module:id},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.click=fn;}}));
const panels=MODULES.map(id=>({dataset:{modulePanel:id},hidden:id!=="overview"}));
const root={hidden:true,querySelectorAll(s){return s==="[data-module]"?buttons:panels;}};
assert.equal(selectModule(root,"events"),false);
assert.equal(panels.filter(x=>!x.hidden).length,1);
root.hidden=false;
attachDashboard(root);
for(const id of MODULES){
 assert.match(dashboard,new RegExp('data-module="'+id+'"'));
 assert.match(dashboard,new RegExp('id="module-'+id+'"'));
 buttons.find(b=>b.dataset.module===id).click();
 assert.equal(panels.filter(p=>!p.hidden).length,1);
 assert.equal(panels.find(p=>!p.hidden).dataset.modulePanel,id);
 assert.equal(buttons.filter(b=>b.attrs["aria-pressed"]==="true").length,1);
}
assert.equal(selectModule(root,"unknown"),false);
root.hidden=true;
assert.equal(selectModule(root,"overview"),false);
assert.equal(root.hidden,true);
assert.doesNotMatch(js,/\b(fetch|localStorage|sessionStorage|innerHTML|eval)\b|\.rpc\(|\.auth\./);
for(const id of ["login-form","passkey-login","challenge-form","register-passkey","signout"])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
console.log("Dashboard navigation, markup gate, invalid selection, and no-data assertions passed.");

const mobile=dashboard.match(/<section id="module-mobile"[\s\S]*?<\/section>/)?.[0]||"";
assert.match(mobile,/Inactive — Future Integration/);
assert.match(mobile,/No app connection or publishing enabled/);
assert.doesNotMatch(mobile,/<(?:form|button|input|a)\b/i);
assert.match(dashboard,/data-module="mobile"[^>]*>Mobile app <span class="module-state">Inactive<\/span>/);
assert.match(dashboard,/Published news/);
assert.match(dashboard,/Published events/);
assert.match(dashboard,/Published sponsor entries/);
console.log("Inactive mobile status and no integration controls verified.");

for(const v of ["contacts","inquiries","subscribers","preferences","consent","suppressions"])assert.match(dashboard,new RegExp('data-reader="'+v+'"'));
for(const v of ["email","sms"]){
 const section=dashboard.match(new RegExp('<section id="module-'+v+'"[\\s\\S]*?<\\/section>'))?.[0]||"";
 assert.match(section,/Inactive — Delivery Not Enabled/);
 assert.doesNotMatch(section,/<(?:form|button|input|a)\b/i);
}
