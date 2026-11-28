# Disposable CI database only. Never invoke with a hosted connection.
import os, subprocess, concurrent.futures, uuid
from pathlib import Path
socket=os.environ["HAG_QA_SOCKET"]
assert socket.startswith("/tmp/hag-pg-") and Path(socket).is_dir()
env={k:v for k,v in os.environ.items() if not k.startswith("PG")}
def sql(q, role=True):
    cmd=["psql","-X","-qAt","-v","ON_ERROR_STOP=1","-h",socket,"-d","hag_qa","-U",os.environ["USER"]]
    prefix="set statement_timeout='8s';set lock_timeout='4s';"
    if role: prefix+="set role hag_subscription_runtime;"
    result=subprocess.run(cmd,input=prefix+q,text=True,capture_output=True,env=env,timeout=12)
    if result.returncode: raise RuntimeError("Isolated SQL operation failed: "+result.stderr.splitlines()[0][:100])
    return result.stdout.strip()
def parallel(queries):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(sql,queries))
def issue(rid,d,topic="hag-announcements"):
    return f"select coalesce(hag_private.subscription_gateway_issue('{rid}','subscribe','QA',true,'email','{d}',array['{topic}'],true,'draft-3c3-v1','confirm'),'');"
def access(d):
    return sql(f"select hag_private.subscription_gateway_issue('{uuid.uuid4()}','access',null,null,'email','{d}',null,null,null,'unsubscribe');")
def redeem(t,p):
    assert len(t)==64 and all(c in "0123456789abcdef" for c in t)
    return f"select coalesce(hag_private.subscription_redeem('{t}','{p}')::text,'');"
def clear_limits():
    sql("delete from hag_private.subscription_abuse;",False)
assert sql("select has_table_privilege(current_user,'hag_private.hag_contacts','SELECT'),has_table_privilege(current_user,'hag_private.subscription_capabilities','SELECT'),has_function_privilege(current_user,'hag_private.stage_subscription_request(text,boolean,text,text,text[],boolean,text)','execute');")=="f|f|f"
d="concurrent@example.invalid"; rid=str(uuid.uuid4())
results=parallel([issue(rid,d)]*8); tokens=[v for v in results if v]
assert len(tokens)==1, "duplicate concurrent issuance"
assert sql("select count(*) from hag_private.hag_subscriptions;",False)=="1"
assert sql("select count(*) from hag_private.hag_consent_events;",False)=="1"
results=parallel([redeem(tokens[0],"confirm")]*8)
assert sum('true' in v for v in results)==1, "duplicate concurrent redemption"
assert sql("select count(*) from hag_private.hag_consent_events where event_kind='confirmed';",False)=="1"
clear_limits()
d="race@example.invalid"; a=sql(issue(str(uuid.uuid4()),d)); u=access(d)
parallel([redeem(a,"confirm"),redeem(u,"unsubscribe")])
assert sql("select count(*) from hag_private.hag_subscriptions s join hag_private.hag_contact_methods m on m.id=s.contact_method_id where m.destination='race@example.invalid' and s.status='active';",False)=="0"
assert sql("select count(*) from hag_private.hag_suppressions s join hag_private.hag_contact_methods m on m.id=s.contact_method_id where m.destination='race@example.invalid' and s.active;",False)=="1"
clear_limits()
d="edit-race@example.invalid"; a=sql(issue(str(uuid.uuid4()),d));sql(redeem(a,"confirm"))
m=sql(f"select hag_private.subscription_gateway_issue('{uuid.uuid4()}','access',null,null,'email','{d}',null,null,null,'manage');")
import json
edit=json.loads(sql(redeem(m,"manage")))["edit_token"];u=access(d)
parallel([f"select hag_private.subscription_edit('{edit}',array['camps-clinics'],array[]::text[],true,true,'draft-3c3-v1');",redeem(u,"unsubscribe")])
assert sql("select count(*) from hag_private.hag_subscriptions s join hag_private.hag_contact_methods m on m.id=s.contact_method_id where m.destination='edit-race@example.invalid' and s.status='active';",False)=="0"
assert sql("select count(*) from hag_private.hag_suppressions s join hag_private.hag_contact_methods m on m.id=s.contact_method_id where m.destination='edit-race@example.invalid' and s.active;",False)=="1"
print("PASS: independent PostgreSQL connections, duplicate issue/redemption, confirm/opt-out race, edit/opt-out race, narrow runtime role")
