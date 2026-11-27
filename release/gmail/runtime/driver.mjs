// Release candidate only. No database connection is opened by importing this module.
const ref="unrqbfngcgvqnytxbtgj";
const roles={control:["hag_gmail_control","hag_gmail_control_login"],dispatch:["hag_gmail_dispatch","hag_gmail_dispatch_login"],gateway:["hag_subscription_runtime","hag_subscription_gateway_login"]};
export function checkedDbOptions(url,ca,kind){
 const identity=roles[kind];if(!identity)throw Error("Invalid database identity");
 const u=new URL(url),[role,login]=identity;
 if(!["postgres:","postgresql:"].includes(u.protocol)||!/^aws-[0-9]+-us-east-2\.pooler\.supabase\.com$/.test(u.hostname)||u.port!=="6543"||u.pathname!=="/postgres"||decodeURIComponent(u.username)!==login+"."+ref||!u.password||u.search||u.hash)throw Error("Invalid private database connection");
 if(typeof ca!=="string"||ca.length>16384||!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca))throw Error("Verified database CA required");
 return {role,login,options:{host:u.hostname,port:6543,database:"postgres",username:decodeURIComponent(u.username),password:decodeURIComponent(u.password),ssl:{ca,rejectUnauthorized:true,servername:u.hostname},prepare:false,max:1,connect_timeout:5,idle_timeout:10,max_lifetime:60}};
}
export function createReleaseExecutor({postgres,url,ca,kind}){
 if(typeof postgres!=="function")throw Error("Pinned PostgreSQL driver required");
 const {role,login,options}=checkedDbOptions(url,ca,kind);
 const sql=postgres(options);let active=false;
 const execute=async(q,args)=>{
  if(active)throw Error("Runtime busy");active=true;
  try{return await sql.begin(async tx=>{
   await tx.unsafe("SET LOCAL statement_timeout = '3000ms'");await tx.unsafe("SET LOCAL lock_timeout = '1000ms'");await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
   await tx.unsafe("SET LOCAL ROLE "+role);
   const rows=await tx.unsafe("select current_user as role, session_user as login, (select not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit) from pg_roles where rolname=session_user) as narrow");
   if(rows[0]?.role!==role||rows[0]?.login!==login||rows[0]?.narrow!==true)throw Error("Unexpected runtime identity");
   // SQL strings originate exclusively in the fixed server adapters; never from requests.
   if(typeof q!=="string"||!/^select hag_private\.[a-z_]+\(/.test(q)||!Array.isArray(args))throw Error("Fixed private query required");
   const result=await tx.unsafe(q,args.map(x=>Array.isArray(x)?tx.array(x,25):x));
   return {rows:result};
  });}catch{throw Error("Private runtime unavailable");}finally{active=false;}
 };
 return Object.freeze({execute,close:()=>sql.end({timeout:1})});
}
