// Browser regression runner: local loopback only; no provider/network dependencies.
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,extname} from "node:path";
import assert from "node:assert/strict";
const root=resolve("previews/subscriptions");
const harness=resolve("tests/subscription-center-browser.html");
const mime={".html":"text/html; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,"http://localhost").pathname;
  const file=path==="/qa.html"?harness:resolve(root,"."+path);
  if(file!==harness&&(!file.startsWith(root+"/")||!mime[extname(file)]))throw Error();
  res.writeHead(200,{"content-type":mime[extname(file)],"cache-control":"no-store"});res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const profile=await mkdtemp(join(tmpdir(),"hag-chrome-"));
try{
 const chrome=process.env.CHROME_BIN||"google-chrome";
 const args=["--headless","--disable-gpu","--no-sandbox","--disable-dev-shm-usage","--disable-background-networking","--no-first-run","--no-default-browser-check","--user-data-dir="+profile,"--virtual-time-budget=20000","--dump-dom","http://127.0.0.1:"+server.address().port+"/qa.html"];
 const result=await new Promise((ok,fail)=>{
  const child=spawn(chrome,args,{stdio:["ignore","pipe","pipe"]});let out="",err="";
  const timeout=setTimeout(()=>{child.kill("SIGKILL");fail(Error("Browser test timeout"));},45000);
  child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
  child.on("error",e=>{clearTimeout(timeout);fail(e);});child.on("close",code=>{clearTimeout(timeout);ok({code,out,err});});
 });
 assert.equal(result.code,0,result.err.slice(-2000));
 assert.match(result.out,/id="result"[^>]*>PASS:/,result.out.slice(-3000));
 console.log(result.out.match(/PASS:[^<]+/)?.[0]);
}finally{await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
