# Disposable local PostgreSQL only; no real recipients or delivery.
import os, subprocess, concurrent.futures, uuid, json
from pathlib import Path
socket=os.environ["HAG_QA_SOCKET"]
assert socket.startswith("/tmp/hag-pg-") and Path(socket).is_dir()
env={k:v for k,v in os.environ.items() if not k.startswith("PG")}
def sql(q, role=None):
    cmd=["psql","-X","-qAt","-v","ON_ERROR_STOP=1","-h",socket,"-d","hag_qa","-U",os.environ["USER"]]
    prefix="set statement_timeout='8s';set lock_timeout='4s';"
    if role: prefix+="set role "+role+";"
    r=subprocess.run(cmd,input=prefix+q,text=True,capture_output=True,env=env,timeout=12)
    if r.returncode: raise RuntimeError("Outbox SQL operation failed")
    return r.stdout.strip()
def parallel(q, role):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        return list(ex.map(lambda _:sql(q,role),range(8)))
runtime="hag_subscription_runtime";worker="hag_email_worker";key="c"*64
rid=str(uuid.uuid4())
sql("update hag_private.subscription_email_limits set daily=80,monthly=2400; delete from hag_private.subscription_abuse;")
q=f"select hag_private.subscription_enqueue_email('{rid}','subscribe','Fixture',true,'worker-race@example.invalid',array['hag-announcements'],true,'draft-3c3-v1','confirm','{key}','fixture-v2');"
parallel(q,runtime)
assert sql(f"select count(*) from hag_private.subscription_email_outbox where request_id='{rid}';")=="1"
claims=[json.loads(v) for v in parallel("select coalesce(hag_private.subscription_email_claim()::text,'');",worker) if v]
assert len(claims)==1
j=claims[0]["id"];old=claims[0]["lease"]
# Claim transaction and connection have ended; simulate a stopped worker's lease expiration.
sql(f"update hag_private.subscription_email_outbox set lease_until=clock_timestamp()-interval '1 second' where id='{j}';")
claims=[json.loads(v) for v in parallel("select coalesce(hag_private.subscription_email_claim()::text,'');",worker) if v]
assert len(claims)==1 and claims[0]["id"]==j and claims[0]["lease"]!=old
lease=claims[0]["lease"]
def step(l):return f"select hag_private.subscription_email_sim_step('{j}','{l}','{key}','fixture-v2','accept');"
assert sql(step(old),worker)=="stale"
results=parallel(step(lease),worker)
assert results.count("accepted")==1 and results.count("stale")==7
assert sql(f"select count(*) from hag_private.subscription_email_sim_acceptance where job_id='{j}';")=="1"
assert sql(f"select (payload is null)::text from hag_private.subscription_email_outbox where id='{j}';")=="true"
print("PASS: independent outbox connections, concurrent enqueue/claim, persisted lease recovery, concurrent fenced acceptance")
