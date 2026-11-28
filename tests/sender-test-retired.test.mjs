import assert from "node:assert/strict";
import {handler} from "../release/gmail/sender-test-retired.mjs";
for(const method of ["GET","POST","OPTIONS","HEAD"]){const r=handler(new Request("https://example.invalid/run",{method}));assert.equal(r.status,410);assert.equal(await r.text(),"");}
console.log("PASS: retired sender test cannot send or read private configuration");
