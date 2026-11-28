// Review-only sport-aware contract. No transport or provider calls.
export const VERSION="draft-sports-v2";
export const ALL="all-sports";
export const SPORTS=Object.freeze([["basketball","Basketball"],["volleyball","Volleyball"],["baseball","Baseball"],["softball","Softball"],["football","Football"],["soccer","Soccer"]].map(Object.freeze));
export const UPDATES=Object.freeze([["general","General H.A.G. announcements","general"],["enforcers","Heartland Enforcers Basketball Club","basketball"],["gus-macker","Gus Macker – Quincy","basketball"],["tryouts-registration","Tryouts and registrations","sport"],["camps-clinics","Camps and clinics","sport"],["tournaments-events","Tournaments and events","sport"],["recreational-leagues","Youth recreational leagues","sport"],["sponsorship","Sponsorship opportunities","either"],["volunteer","Volunteer opportunities","either"]].map(Object.freeze));
const validList=(a,max)=>Array.isArray(a)&&a.length<=max&&a.every(x=>typeof x==="string")&&new Set(a).size===a.length;
export function validSelection(sports,updates,catalog=SPORTS.map(([code])=>code)){
 if(!validList(sports,40)||!validList(updates,9)||!updates.length||sports.some(x=>x!==ALL&&!catalog.includes(x))||sports.includes(ALL)&&sports.length!==1)return false;
 const types=updates.map(x=>UPDATES.find(t=>t[0]===x));if(types.some(x=>!x))return false;
 if(!sports.length&&types.some(t=>["sport","basketball"].includes(t[2])))return false;
 return !types.some(t=>t[2]==="basketball")||sports.includes("basketball")||sports.includes(ALL);
}
export function validTarget({sport,update,channel},catalog=SPORTS.map(([code])=>code)){
 const t=UPDATES.find(x=>x[0]===update);if(!t||!["email","sms"].includes(channel))return false;
 return sport===null?["general","either"].includes(t[2]):catalog.includes(sport)&&(["sport","either"].includes(t[2])||t[2]==="basketball"&&sport==="basketball");
}
export function matches(p,target,catalog){
 return validTarget(target,catalog)&&p.channel===target.channel&&p.status==="active"&&!p.suppressed&&(p.channel!=="sms"||p.verified===true)&&p.updates.includes(target.update)&&(target.sport===null||p.sports.includes(target.sport)||p.sports.includes(ALL));
}
export function audienceCount(records,target,catalog){
 return new Set(records.filter(p=>matches(p,target,catalog)).map(p=>p.methodId)).size;
}
