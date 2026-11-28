import {randomBytes,createHash} from "node:crypto";
export function createAuthorizationPlan({clientId,redirectUri}){
 const state=randomBytes(32).toString("base64url"),verifier=randomBytes(32).toString("base64url");
 return {parameters:{client_id:clientId,redirect_uri:redirectUri,response_type:"code",scope:"https://www.googleapis.com/auth/gmail.send",access_type:"offline",prompt:"consent",include_granted_scopes:"false",login_hint:"jhawkins@heartlandathleticsgroup.com",state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"},verifier};
}
