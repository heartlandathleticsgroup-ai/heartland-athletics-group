import {validateAssertion,verifiedPasskey} from "../supabase/functions/hag-admin-passkey/verify.mjs";
import assert from "node:assert/strict";
const b64=b=>Buffer.from(b).toString("base64url");
const id="11111111-1111-4111-8111-111111111111",sid="22222222-2222-4222-8222-222222222222",base="https://unrqbfngcgvqnytxbtgj.supabase.co";
const make=(flag=5,origin="https://heartlandathleticsgroup.com")=>{const a=new Uint8Array(37);a[32]=flag;const raw=b64([1,2,3]);return {challenge_id:id,credential:{id:raw,rawId:raw,type:"public-key",response:{authenticatorData:b64(a),clientDataJSON:b64(JSON.stringify({type:"webauthn.get",origin,challenge:b64([4,5,6]),crossOrigin:false})),signature:b64([7]),userHandle:b64([8])}}};};
assert.equal(validateAssertion(make()).credentialB64,"AQID");
for(const flag of [0,1,4])assert.throws(()=>validateAssertion(make(flag)));
assert.throws(()=>validateAssertion(make(5,"https://evil.example")));
const wrong=make();wrong.credential.id="AQIE";assert.throws(()=>validateAssertion(wrong));
const token="a."+b64(JSON.stringify({sub:id,session_id:sid,role:"authenticated",iss:base+"/auth/v1",is_anonymous:false,amr:[{method:"passkey"}]}))+".b";
const result={access_token:token,refresh_token:"synthetic",user:{id}};
function mock({native=200,check=200,grant=true}={}){let i=0;return async(url,opts)=>{i++;if(i===1){assert.equal(url,base+"/auth/v1/passkeys/authentication/verify");assert.deepEqual(JSON.parse(opts.body),validateAssertion(make()).payload);return new Response(JSON.stringify(result),{status:native});}if(i===2){assert.equal(url,base+"/auth/v1/user");return new Response(JSON.stringify({id}),{status:check});}assert.equal(url,base+"/rest/v1/rpc/hag_record_verified_passkey");assert.deepEqual(JSON.parse(opts.body),{p_session_id:sid,p_user_id:id,p_credential_b64:"AQID"});return new Response(JSON.stringify(grant));};}
const run=request=>verifiedPasskey(make(),{base,anon:"test",service:"test",request});
assert.deepEqual(await run(mock()),{access_token:token,refresh_token:"synthetic"});
await assert.rejects(run(mock({native:400})));await assert.rejects(run(mock({check:401})));await assert.rejects(run(mock({grant:false})));
console.log("Passkey gateway unit tests passed (mocked Auth only; not a live WebAuthn test).");
