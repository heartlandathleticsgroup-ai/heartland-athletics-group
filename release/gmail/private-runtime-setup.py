#!/usr/bin/env python3
"""Owner-local, first-time H.A.G. private runtime provisioning. No Google or messaging calls."""
import argparse
import base64
import datetime as dt
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import warnings

REF = "unrqbfngcgvqnytxbtgj"
ROLES = (
    ("hag_gmail_control_login", "hag_gmail_control", "HAG_GMAIL_CONTROL_DATABASE_URL"),
    ("hag_gmail_dispatch_login", "hag_gmail_dispatch", "HAG_GMAIL_DISPATCH_DATABASE_URL"),
    ("hag_subscription_gateway_login", "hag_subscription_runtime", "HAG_SUBSCRIPTION_DATABASE_URL"),
)
INITIAL = {"HAG_GMAIL_CLIENT_ID", "HAG_GMAIL_CLIENT_SECRET", "HAG_GMAIL_RUNTIME_STATE",
           "HAG_GMAIL_OAUTH_ENABLED", "HAG_GMAIL_SEND_ENABLED", "HAG_PREFERENCES_ENABLED",
           "HAG_SPORT_PREFERENCES_ENABLED"}
NEW = {r[2] for r in ROLES} | {"HAG_DATABASE_CA_PEM", "HAG_GMAIL_VAULT_KEY",
       "HAG_GMAIL_VAULT_KEY_VERSION", "HAG_EMAIL_OUTBOX_KEY", "HAG_EMAIL_OUTBOX_KEY_VERSION",
       "HAG_GMAIL_WORKER_KEY", "HAG_PRIVATE_POSTAL_FOOTER", "HAG_PROJECT_PUBLISHABLE_KEY"}
HOST = re.compile(r"aws-[0-9]+-us-east-2\.pooler\.supabase\.com\Z")
LOGIN_LIST = ",".join("'" + r[0] + "'" for r in ROLES)
class SetupError(Exception): pass
class PoolerAuthError(SetupError): pass

def fail(message):
    raise SetupError(message)

def private_input(prompt, trim=True):
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        fail("Run this tool in your own interactive Terminal.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        value = getpass.getpass(prompt)
        return value.strip() if trim else value

def scram(password, salt=None):
    # A verifier, not a plaintext password, is submitted to PostgreSQL.
    salt = salt if salt is not None else secrets.token_bytes(16)
    count = 16384
    salted = hashlib.pbkdf2_hmac("sha256", password.encode("ascii"), salt, count)
    client = hmac.digest(salted, b"Client Key", "sha256")
    stored = hashlib.sha256(client).digest()
    server = hmac.digest(salted, b"Server Key", "sha256")
    b64 = lambda value: base64.b64encode(value).decode("ascii")
    return "SCRAM-SHA-256$" + str(count) + ":" + b64(salt) + "$" + b64(stored) + ":" + b64(server)

def run(args, env=None, data=None, timeout=45, label="Local command"):
    try:
        result = subprocess.run(args, env=env, input=data, text=True, capture_output=True,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail(label + " unavailable or timed out; no raw output shown.")
    if result.returncode:
        # Inspect only locally; expose fixed categories, never server-provided text.
        if label == "TLS database operation":
            err = result.stderr.lower()
            if "password authentication failed" in err or "28p01" in err:
                raise PoolerAuthError("Database password authentication rejected.")
            if "certificate" in err or "ssl error" in err:
                fail("Database TLS certificate verification failed.")
            if "could not translate host name" in err or "could not resolve" in err:
                fail("Database hostname resolution failed.")
            if "timeout" in err or "timed out" in err:
                fail("Database connection timed out.")
            if "circuit breaker" in err or "too many" in err:
                fail("Database pooler rate limit or circuit breaker; do not retry.")
        fail(label + " failed; no raw output shown to protect credentials.")
    return result.stdout

def psql(host, port, user, password, ca, query):
    # Exclude inherited PG* overrides (service files, SSL settings, user, etc.).
    env = {k:v for k,v in os.environ.items() if k in ("PATH","HOME","LANG","LC_ALL","TMPDIR","SYSTEMROOT")}
    env.update(PGPASSWORD=password, PGSSLMODE="verify-full", PGSSLROOTCERT=str(ca),
               PGCONNECT_TIMEOUT="8", PGAPPNAME="hag-private-runtime-setup")
    return run(["psql","-X","-w","-qAt","-v","ON_ERROR_STOP=1","-h",host,"-p",str(port),
                "-U",user+"."+REF,"-d","postgres"],env=env,data=query,
               label="TLS database operation").strip()

def cli_args(action):
    help_text = run(["supabase","secrets",action,"--help"],label="Supabase CLI help")
    target = ["--remote="+REF] if "--remote" in help_text else ["--project-ref",REF] if "--project-ref" in help_text else None
    if target is None:
        fail("Installed CLI does not advertise an explicit hosted project target.")
    args = ["supabase","secrets",action,*target]
    if action == "set":
        # CLI v3 requires explicit confirmation. v2 may omit this flag.
        if "--yes" in help_text: args.append("--yes")
        if "--env-file" not in help_text: fail("CLI does not support private env-file input.")
    return args

def secret_names():
    output = run(cli_args("list"),label="Supabase authenticated secret-name check")
    return set(re.findall(r"\bHAG_[A-Z0-9_]+\b",output))

def make_values(host, passwords, pem, publishable, footer):
    values = {env: "postgresql://" + login + "." + REF + ":" + passwords[login] + "@" +
                    host + ":6543/postgres" for login,role,env in ROLES}
    values.update(HAG_DATABASE_CA_PEM=pem, HAG_PROJECT_PUBLISHABLE_KEY=publishable,
                  HAG_PRIVATE_POSTAL_FOOTER=footer, HAG_GMAIL_VAULT_KEY=secrets.token_hex(32),
                  HAG_EMAIL_OUTBOX_KEY=secrets.token_hex(32), HAG_GMAIL_WORKER_KEY=secrets.token_hex(32),
                  HAG_GMAIL_VAULT_KEY_VERSION="v1", HAG_EMAIL_OUTBOX_KEY_VERSION="v1")
    return values

def validate_inputs(host, pem, publishable, footer):
    if not HOST.fullmatch(host):
        fail("Use the exact US East (Ohio) shared pooler hostname from H.A.G.'s Connect panel.")
    if not (15 <= len(footer) <= 300) or any(ord(x)<32 or ord(x)==127 for x in footer):
        fail("Use the approved single-line business postal address.")
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]+",publishable):
        fail("Only the existing sb_publishable_ key is accepted, never a secret/service-role key.")
    if len(pem)>16384 or not re.fullmatch(r"-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*",pem):
        fail("Select the official downloaded Supabase database CA PEM certificate.")

def upload(values):
    # CLI reads a temporary owner-only file outside the repo. No secret arguments or output.
    # JSON double quoting preserves newline escapes in PEM and punctuation in the postal footer.
    args = cli_args("set")
    with tempfile.TemporaryDirectory(prefix="hag-private-") as directory:
        path = Path(directory)/"runtime.env"
        fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as file:
            for key,value in values.items():
                file.write(key+"="+json.dumps(value,ensure_ascii=False)+"\n")
        env = dict(os.environ)
        env["SUPABASE_YES"] = "true"
        run(args+["--env-file",str(path)],env=env,timeout=90,label="Private Supabase secret upload")

PREFLIGHT = """begin read only;
do $qa$ begin
 if current_user<>'postgres' then raise exception 'Unexpected operator identity';end if;
 if not exists(select 1 from hag_private.gmail_connection where singleton and not enabled and credential is null and generation=0)
 or exists(select 1 from hag_private.hag_subscriptions)
 or exists(select 1 from hag_private.subscription_email_outbox)
 or exists(select 1 from hag_private.gmail_sender_review) then raise exception 'Not the empty disabled baseline';end if;
 if (select count(*) from pg_roles where rolname in (""" + LOGIN_LIST + """)
 and not rolcanlogin and not rolcreaterole and not rolcreatedb and not rolinherit
 and not rolsuper and not rolbypassrls)<>3 then raise exception 'Unsafe identities';end if;
end $qa$;
select 'PASS';
rollback;
"""

def verify_restricted(host, login, password, ca, check):
    # Supavisor may briefly cache an old role secret after rotation. Reuse the
    # exact credential once; never rotate again or retry TLS/other errors.
    try:
        return psql(host,6543,login,password,ca,check)
    except PoolerAuthError:
        print("NOTICE: "+login+" pooler authentication rejected; one retry after cache refresh.")
        time.sleep(25)
        try:
            return psql(host,6543,login,password,ca,check)
        except PoolerAuthError:
            fail("Restricted pooler authentication rejected twice for "+login+"; no further retry.")

def disabled(owner):
    return owner("select count(*) from pg_roles where rolname in ("+LOGIN_LIST+") and rolcanlogin;") == "0"

def configure(host,ca,pem,publishable,footer,owner_password):
    # Existing Google secrets and safety switches must be present. Never rotate a configured key.
    names = secret_names()
    if not INITIAL <= names:
        fail("Missing original Google credentials or safety switch names. Check dashboard names only.")
    if NEW & names:
        fail("One or more runtime secrets already exist. Stop rather than overwrite keys or passwords.")
    owner = lambda sql: psql(host,5432,"postgres",owner_password,ca,sql)
    if owner(PREFLIGHT)!="PASS": fail("Disabled database preflight did not pass.")
    passwords = {login:secrets.token_hex(32) for login,role,env in ROLES}
    values = make_values(host,passwords,pem,publishable,footer)
    print("PASS: project secret-name and TLS owner preflight.")
    # Temporarily allow exactly one narrow login at a time. Expiration is a crash safeguard.
    # This is NOT enabling the Edge runtime, Gmail, SMS, or subscriber signup.
    for login,role,env in ROLES:
        expires = (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).strftime("%Y-%m-%d %H:%M:%S+00")
        try:
            owner("alter role "+login+" login password '"+scram(passwords[login])+"' valid until '"+expires+"';")
            check = ("begin read only; set local role "+role+"; "
                     "select case when current_user='"+role+"' and session_user='"+login+"' and "
                     "not exists(select 1 from pg_roles where rolname=session_user and "
                     "(rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit)) "
                     "then 'PASS' else 'FAIL' end; rollback;")
            if verify_restricted(host,login,passwords[login],ca,check)!="PASS":
                fail("Restricted transaction-pooler identity verification did not pass.")
            print("PASS: "+login+" TLS and assigned role.")
        finally:
            # Always restore NOLOGIN. On failure, expiration remains in force.
            try:
                owner("alter role "+login+" nologin;")
                # NOLOGIN alone does not close an already pooled database session.
                owner("select pg_terminate_backend(pid) from pg_stat_activity where usename='"+login+"' and pid<>pg_backend_pid();")
            except SetupError:
                fail("STOP: role shutoff could not be confirmed. Do not rerun; use the documented NOLOGIN recovery query.")
        if not disabled(owner):
            fail("STOP: a runtime login is still enabled. Use the documented recovery query.")
    # Keep NOLOGIN while retaining fresh passwords for a later coordinated connection-only release.
    owner("begin; "+" ".join("alter role "+login+" nologin valid until 'infinity';" for login,role,env in ROLES)+" commit;")
    if not disabled(owner): fail("STOP: runtime login shutoff not confirmed.")
    # Recheck names immediately before upload; no overwriting existing runtime secrets.
    if NEW & secret_names(): fail("Runtime secrets appeared during setup. Stop before upload.")
    upload(values)
    if not NEW <= secret_names(): fail("Private upload not fully confirmed. Stop; do not rerun blindly.")
    if not disabled(owner): fail("STOP: final runtime login shutoff not confirmed.")
    print("PASS: all 11 runtime secret names present; three identities returned to NOLOGIN.")
    print("COMPLETE: no Gmail authorization, email, SMS, worker scheduling or website publication.")

def self_test():
    fixed = scram("test-password",b"0123456789abcdef")
    assert fixed.startswith("SCRAM-SHA-256$16384:MDEyMzQ1Njc4OWFiY2RlZg==$")
    assert fixed == scram("test-password",b"0123456789abcdef")
    assert fixed != scram("different",b"0123456789abcdef")
    host = "aws-0-us-east-2.pooler.supabase.com"
    ca = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n"
    validate_inputs(host,ca,"sb_publishable_fixture","Fictional fixture postal address")
    try: validate_inputs("evil.invalid",ca,"sb_publishable_fixture","Fictional fixture postal address")
    except SetupError: pass
    else: raise AssertionError("host accepted")
    try: validate_inputs(host,ca,"sb_secret_fixture","Fictional fixture postal address")
    except SetupError: pass
    else: raise AssertionError("secret key accepted")
    values = make_values(host,{r[0]:"0"*64 for r in ROLES},ca,"sb_publishable_fixture","Fictional fixture postal address")
    assert set(values)==NEW and len(NEW)==11
    assert len({values[k] for k in ("HAG_GMAIL_VAULT_KEY","HAG_EMAIL_OUTBOX_KEY","HAG_GMAIL_WORKER_KEY")})==3
    assert all(len(values[k])==64 for k in ("HAG_GMAIL_VAULT_KEY","HAG_EMAIL_OUTBOX_KEY","HAG_GMAIL_WORKER_KEY"))
    assert all(values[r[2]].startswith("postgresql://"+r[0]+"."+REF+":") for r in ROLES)
    assert all(values[r[2]].endswith("@"+host+":6543/postgres") for r in ROLES)
    # Simulated first-time setup exercises the actual orchestration, not only helpers.
    import contextlib
    import io
    from unittest.mock import patch
    import types
    module = sys.modules[__name__]
    for reject in (False,True):
        state = {"active":set(), "names":set(INITIAL), "uploaded":False, "tests":[]}
        def fake_psql(h,port,user,password,certificate,query):
            assert h==host
            if user=="postgres":
                assert port==5432
                if query==PREFLIGHT: return "PASS"
                if query.startswith("select count(*) from pg_roles"): return str(len(state["active"]))
                for login,role,env in ROLES:
                    if ("alter role "+login+" login password ") in query:
                        assert not state["active"] and "SCRAM-SHA-256$" in query and "valid until" in query
                        state["active"].add(login)
                    if ("alter role "+login+" nologin") in query: state["active"].discard(login)
                return ""
            assert port==6543 and state["active"]=={user} and "begin read only;" in query
            assert len(password)==64 and password not in query
            state["tests"].append(user)
            return "FAIL" if reject else "PASS"
        def fake_upload(bundle):
            assert not state["active"] and set(bundle)==NEW
            state["names"].update(bundle)
            state["uploaded"]=True
        with patch.object(module,"psql",fake_psql),patch.object(module,"secret_names",lambda:set(state["names"])),patch.object(module,"upload",fake_upload),contextlib.redirect_stdout(io.StringIO()) as output:
            try: configure(host,Path("fixture.crt"),ca,"sb_publishable_fixture","Fictional fixture postal address","fixture-owner")
            except SetupError:
                assert reject
            else: assert not reject
            assert "fixture-owner" not in output.getvalue() and "postgresql://" not in output.getvalue()
        assert not state["active"] and state["uploaded"] is not reject
        assert len(state["tests"])==(1 if reject else 3)
    # Bounded retry only for authentication rejection, reusing identical password.
    calls=[]
    def flaky(*args):
        calls.append(args)
        if len(calls)==1: raise PoolerAuthError("fixture")
        return "PASS"
    with patch.object(module,"psql",flaky),patch.object(time,"sleep",lambda n:None),contextlib.redirect_stdout(io.StringIO()):
        assert verify_restricted(host,ROLES[0][0],"fixture-password",Path("fixture.crt"),"fixture-check")=="PASS"
    assert len(calls)==2 and calls[0]==calls[1]
    calls.clear()
    def rejected(*args):
        calls.append(args)
        raise PoolerAuthError("fixture")
    with patch.object(module,"psql",rejected),patch.object(time,"sleep",lambda n:None),contextlib.redirect_stdout(io.StringIO()):
        try: verify_restricted(host,ROLES[0][0],"fixture-password",Path("fixture.crt"),"fixture-check")
        except SetupError: pass
        else: raise AssertionError("persistent auth failure accepted")
    assert len(calls)==2 and calls[0]==calls[1]
    calls.clear()
    def bad_tls(*args):
        calls.append(args)
        raise SetupError("fixture TLS failure")
    with patch.object(module,"psql",bad_tls),patch.object(time,"sleep",lambda n:None):
        try: verify_restricted(host,ROLES[0][0],"fixture-password",Path("fixture.crt"),"fixture-check")
        except SetupError: pass
        else: raise AssertionError("TLS failure accepted")
    assert len(calls)==1
    print("PASS: offline private setup, unique keys, narrow URLs, SCRAM, temporary login cleanup and no upload on TLS failure; bounded same-password pooler retry")

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test",action="store_true")
    args=parser.parse_args()
    if args.self_test: self_test(); return
    if not sys.stdin.isatty(): fail("Run interactively on your own Mac.")
    for tool in ("psql","supabase"):
        if not shutil.which(tool): fail(tool+" is not installed or on PATH. Stop before creating credentials.")
    print("H.A.G. first-time private setup. Project "+REF+". Gmail and public signup remain locked.")
    # No passwords are placed in a URL entered by the owner or in shell history.
    host=input("Shared pooler hostname from H.A.G. Connect (hostname only): ").strip()
    path=Path(input("Official downloaded database CA certificate file path: ").strip().strip("'\"")).expanduser()
    try: pem=path.read_text(encoding="utf-8")
    except (OSError,UnicodeError): fail("Cannot read CA file.")
    publishable=private_input("Existing project publishable key (hidden): ")
    footer=private_input("Approved business mailing address, one line (hidden): ")
    validate_inputs(host,pem,publishable,footer)
    owner_password=private_input("Existing Supabase database password (hidden; not reset): ",trim=False)
    if not owner_password: fail("Database password required.")
    configure(host,path,pem,publishable,footer,owner_password)

if __name__=="__main__":
    try: main()
    except (SetupError,KeyboardInterrupt) as exc:
        print("STOP: "+(str(exc) if isinstance(exc,SetupError) else "Interrupted; verify all three roles are NOLOGIN before retrying."),file=sys.stderr)
        sys.exit(1)
