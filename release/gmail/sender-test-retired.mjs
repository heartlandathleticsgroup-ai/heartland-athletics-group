// Permanent retirement of the single approved test endpoint. No imports, secrets,
// database access, network calls or environment-based unlock.
export function handler(){return new Response(null,{status:410,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"}});}
