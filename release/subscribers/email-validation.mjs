export function validEmail(d){
 if(typeof d!=="string"||d.length>254||d!==d.trim().toLowerCase()||d.includes(".."))return false;
 const [local,domain,...rest]=d.split("@");
 return rest.length===0&&!!domain&&local.length>=1&&local.length<=64&&!local.startsWith(".")&&!local.endsWith(".")&&/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)&&domain.includes(".")&&domain.split(".").every(l=>l.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l));
}
