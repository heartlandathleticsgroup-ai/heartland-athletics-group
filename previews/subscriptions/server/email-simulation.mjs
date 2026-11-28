// Test-only, bounded in-memory outbox. No external client, socket or provider API.
import {createHmac,randomBytes,createCipheriv,createDecipheriv} from "node:crypto";
import {renderTestEmail} from "./email-templates.mjs";
export function createEmailSimulation({now=Date.now,eligible,script=[]}={}){
 if(typeof eligible!=="function")throw Error("Eligibility check required");
 const key=randomBytes(32),hmacKey=randomBytes(32),jobs=new Map(),accepted=new Set();
 let closed=false,pumping=false,index=0;
 const terminal=new Set(["accepted","cancelled","expired","failed"]);
 const finish=(j,state)=>{j.state=state;j.finished=now();j.payload.fill(0);j.payload=null;j.iv=null;j.tag=null;};
 function prune(){for(const [id,j] of jobs){if(!terminal.has(j.state)&&j.deadline<=now()&&j.state!=="processing")finish(j,"expired");if(terminal.has(j.state)&&j.finished+86400000<=now()){jobs.delete(id);accepted.delete(id);}}}
 function open(j){const d=createDecipheriv("aes-256-gcm",key,j.iv);d.setAAD(Buffer.from(j.id));d.setAuthTag(j.tag);return JSON.parse(Buffer.concat([d.update(j.payload),d.final()]).toString("utf8"));}
 return {
  mode:"simulation",
  async accept(v){
   if(closed||v.channel!=="email"||typeof v.issuedAt!=="number"||!Number.isFinite(v.issuedAt)||v.issuedAt>now()+1000)throw Error("Invalid test job");
   renderTestEmail(v); // Strict validation; never retain rendered content.
   prune();
   const id=createHmac("sha256",hmacKey).update(v.token).digest("hex");
   const identity=createHmac("sha256",hmacKey).update(v.destination+"\n"+v.purpose).digest("hex");
   const existing=jobs.get(id);if(existing){if(existing.identity!==identity)throw Error("Conflicting test job");return;}
   if(jobs.size>=200)throw Error("Test queue full");
   const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);c.setAAD(Buffer.from(id));
   const payload=Buffer.concat([c.update(JSON.stringify({destination:v.destination,purpose:v.purpose,token:v.token})),c.final()]);
   const j={id,identity,purpose:v.purpose,state:"queued",attempts:0,next:now(),deadline:v.issuedAt+15*60000,iv,tag:c.getAuthTag(),payload};jobs.set(id,j);
   if(j.deadline<=now())finish(j,"expired");
  },
  async pump(){
   if(closed||pumping)return;pumping=true;
   try{
    prune();
    for(const j of jobs.values()){
     if(!["queued","retry"].includes(j.state)||j.next>now())continue;
     j.state="processing";
     try{
      const v=open(j);
      // A check can fail transiently; never accept an ineligible/expired capability.
      const ok=await eligible(v);
      if(closed)return;
      if(now()>=j.deadline){finish(j,"expired");continue;}
      if(ok!==true){finish(j,"cancelled");continue;}
      j.attempts++;
      renderTestEmail(v);
      // Mock provider accepts a stable job ID once, even if acknowledgement is lost.
      const outcome=accepted.has(j.id)?"accept":(script[index++]||"accept");
      if(outcome==="accept"||outcome==="ambiguous")accepted.add(j.id);
      if(outcome==="accept"){finish(j,"accepted");continue;}
      if(outcome==="permanent"){finish(j,"failed");continue;}
      if(outcome!=="transient"&&outcome!=="ambiguous")throw Error("Invalid test outcome");
     }catch{if(closed)return;if(j.attempts===0||j.state==="processing")j.checkFailures=(j.checkFailures||0)+1;}
     if(j.attempts>=3||(j.checkFailures||0)>=3||now()>=j.deadline){finish(j,now()>=j.deadline?"expired":"failed");continue;}
     j.state="retry";j.next=now()+[30000,120000,300000][Math.min(2,Math.max(j.attempts,j.checkFailures||0)-1)];
    }
   }finally{pumping=false;}
  },
  stats(){prune();return [...jobs.values()].map(j=>({id:j.id,purpose:j.purpose,state:j.state,attempts:j.attempts,payloadRetained:!!j.payload}));},
  acceptedCount(){return accepted.size;},
  close(){closed=true;for(const j of jobs.values())j.payload?.fill(0);jobs.clear();accepted.clear();key.fill(0);hmacKey.fill(0);}
 };
}
