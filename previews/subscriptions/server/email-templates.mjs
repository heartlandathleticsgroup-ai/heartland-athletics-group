// Draft only. Render synthetic recipients and non-live reserved-domain links.
const copy=Object.freeze({
 confirm:{subject:"Confirm your H.A.G. email subscription",action:"Review and confirm",intro:"We received a request to subscribe this email address to updates from Heartland Athletics Group LLC. Review the selected topics and consent before confirming.",expiry:"This link expires 30 minutes after it was issued. If you did not request this, ignore this email. You will not be subscribed without confirmation."},
 manage:{subject:"Manage your H.A.G. email preferences",action:"Review my preferences",intro:"A request was made to view or change the email preferences associated with this address. Use the secure link to review your choices.",expiry:"This link expires 30 minutes after it was issued. If you did not request it, ignore this email."},
 unsubscribe:{subject:"Unsubscribe from H.A.G. marketing email",action:"Unsubscribe from email",intro:"Use the link to stop all Heartland Athletics Group LLC marketing email for this address. Your SMS preferences are unaffected. No login or new consent is required.",expiry:"This link expires 60 days after it was issued. You may also contact us directly to opt out."}
});
export function renderTestEmail({destination,purpose,token}){
 if(typeof destination!=="string"||!/^[-a-z0-9._+]+@[-a-z0-9.]+\.invalid$/i.test(destination)||!Object.hasOwn(copy,purpose)||typeof token!=="string"||! /^[a-f0-9]{64}$/.test(token))throw Error("Synthetic email only");
 const c=copy[purpose],link="https://preview.invalid/preferences#"+purpose+":"+token;
 const footer="Heartland Athletics Group LLC | Quincy, Illinois\nQuestions: info@heartlandathleticsgroup.com";
 const text=c.intro+"\n\n"+c.action+": "+link+"\n\n"+c.expiry+"\n\n"+footer;
 // All interpolated values either fixed copy or strict allowlisted hex. No tracking or marketing.
 const html='<html lang="en"><body><h1>'+c.subject+'</h1><p>'+c.intro+'</p><p><a href="'+link+'">'+c.action+'</a></p><p>'+c.expiry+'</p><p>Heartland Athletics Group LLC · Quincy, Illinois<br>Questions: info@heartlandathleticsgroup.com</p></body></html>';
 return {subject:c.subject,text,html};
}
