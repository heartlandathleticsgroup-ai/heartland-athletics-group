#!/usr/bin/env python3
"""Read-only public DNS and unauthenticated disabled endpoint probes. No credentials or message delivery."""
import json, shlex, urllib.parse, urllib.request, urllib.error, re
domain="heartlandathleticsgroup.com"
def query(name,kind):
    uri="https://dns.google/resolve?"+urllib.parse.urlencode({"name":name,"type":kind})
    with urllib.request.urlopen(uri,timeout=10) as response:
        payload=json.load(response)
    if payload.get("Status") not in (0,3): raise RuntimeError("DNS resolver status")
    return [r["data"] for r in payload.get("Answer",[]) if r.get("type")=={"TXT":16,"MX":15}[kind]]
def txt(name):
    return ["".join(shlex.split(record)) for record in query(name,"TXT")]
try:
    spf=[s for s in txt(domain) if s.lower().startswith("v=spf1")]
    print("SPF POLICY RECORD: "+json.dumps(spf))
    # Only public SPF records are printed; never dump all TXT records or tokens.
    seen=set()
    def google_reference(records,depth=0):
        if depth>5: return False
        for record in records:
            for part in record.lower().split()[1:]:
                term=part.lstrip("+")
                if term.startswith("include:"): target=term[8:]
                elif term.startswith("redirect="): target=term[9:]
                else: continue
                if target=="_spf.google.com": return True
                if target in seen or len(seen)>=10 or not re.fullmatch(r"[a-z0-9_.-]{1,253}",target): continue
                seen.add(target)
                nested=[s for s in txt(target) if s.lower().startswith("v=spf1")]
                if len(nested)==1 and google_reference(nested,depth+1): return True
        return False
    print("SPF GOOGLE REFERENCE (direct or bounded include/redirect): "+str(google_reference(spf)))
    dmarc=[s for s in txt("_dmarc."+domain) if s.lower().startswith("v=dmarc1")]
    dkim=[s for s in txt("google._domainkey."+domain) if re.search(r"(?:^|;)\s*p\s*=\s*[A-Za-z0-9+/]",s)]
    mx=query(domain,"MX")
    policy=re.search(r"(?:^|;)\s*p\s*=\s*(none|quarantine|reject)(?:;|$)",dmarc[0],re.I) if len(dmarc)==1 else None
    print("PUBLIC DNS: "+json.dumps({"spf_count":len(spf),"spf_google_include":any("include:_spf.google.com" in s.lower().split() for s in spf),"dmarc_count":len(dmarc),"dmarc_policy":policy.group(1) if policy else None,"google_selector_dkim_key_present":bool(dkim),"mx_hosts":[r.split()[-1] for r in mx]}))
except Exception as exc:
    print("PUBLIC DNS: unavailable ("+type(exc).__name__+"); verify in Google Admin Toolbox")
for slug in ["hag-subscriptions","hag-gmail-control","hag-gmail-worker"]:
    url="https://unrqbfngcgvqnytxbtgj.supabase.co/functions/v1/"+slug
    try:
        with urllib.request.urlopen(url,timeout=10) as r:
            print("HOSTED GET "+slug+": "+str(r.status)+" (unexpected success; review)")
    except urllib.error.HTTPError as err:
        print("HOSTED GET "+slug+": "+str(err.code))
    except Exception as exc:
        print("HOSTED GET "+slug+": unavailable ("+type(exc).__name__+")")
