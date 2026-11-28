import assert from "node:assert/strict";
import postgres from "npm:postgres@3.4.9";
import {createReleaseExecutor} from "../release/gmail/runtime/driver.mjs";
const port=Number(Deno.env.get("HAG_TEST_PORT")),ca=await Deno.readTextFile(Deno.env.get("HAG_TEST_CA")),wrongCa=await Deno.readTextFile(Deno.env.get("HAG_TEST_WRONG_CA"));
const url="postgresql://hag_subscription_gateway_login.unrqbfngcgvqnytxbtgj:fictional-password@aws-0-us-east-2.pooler.supabase.com:6543/postgres";
// The only network permission is the disposable loopback PostgreSQL server.
// The wrapper rewrites host/port and removes the pooler project suffix, while
// retaining the exact production TLS, transaction and parameter options.
const local=(overrides={})=>options=>postgres({...options,host:"127.0.0.1",port,username:"hag_subscription_gateway_login",ssl:{...options.ssl,...overrides}});
const query="select hag_private.release_tls_fixture($1::text[]) as value";
const run=async(factory)=>{
 const db=createReleaseExecutor({postgres:factory,url,ca,kind:"gateway"});
 try{return await db.execute(query,[["hag-announcements","camps-clinics"]]);}finally{await db.close();}
};
const result=await run(local());
assert.equal(result.rows[0].value.ssl,true);
assert.deepEqual(result.rows[0].value.items,["hag-announcements","camps-clinics"]);
assert.equal(result.rows[0].value.role,"hag_subscription_runtime");
await assert.rejects(run(local({ca:wrongCa})),/Private runtime unavailable/);
await assert.rejects(run(local({servername:"wrong.invalid"})),/Private runtime unavailable/);
console.log("PASS: pinned Deno PostgreSQL driver uses real TLS, verifies CA and hostname, binds text arrays and enforces narrow role in disposable database");
