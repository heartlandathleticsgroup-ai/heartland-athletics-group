"""Real Chromium form navigation on loopback, no credentials or provider calls."""
import http.server, threading, subprocess, shutil, tempfile, re
from pathlib import Path
from urllib.parse import urlparse
policy=re.search(r'<meta name="referrer" content="([^"]+)">',Path("admin/index.html").read_text()).group(1)
assert policy=="strict-origin"
browser=shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")
assert browser,"Chromium required for browser acceptance"
seen=[]
class Receiver(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length","0")))
        seen.append((self.headers.get("Origin"),self.headers.get("Referer")))
        self.send_response(200); self.end_headers(); self.wfile.write(b"form received")
receiver=http.server.ThreadingHTTPServer(("127.0.0.1",0),Receiver)
target=f"http://127.0.0.1:{receiver.server_port}/launch"
class Sender(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        chosen="no-referrer" if urlparse(self.path).path=="/old" else policy
        body=f'<meta name="referrer" content="{chosen}"><form method="POST" action="{target}"><input name="grant" value="synthetic"></form><script>document.forms[0].submit()</script>'
        self.send_response(200); self.send_header("Content-Type","text/html"); self.end_headers(); self.wfile.write(body.encode())
sender=http.server.ThreadingHTTPServer(("127.0.0.1",0),Sender)
for server in [receiver,sender]: threading.Thread(target=server.serve_forever,daemon=True).start()
origin=f"http://127.0.0.1:{sender.server_port}"
try:
    for route in ["/old","/new"]:
        with tempfile.TemporaryDirectory() as profile:
            r=subprocess.run([browser,"--headless","--no-sandbox","--disable-dev-shm-usage","--disable-background-networking","--no-first-run","--user-data-dir="+profile,"--dump-dom",origin+route],capture_output=True,timeout=30)
            assert r.returncode==0 and b"form received" in r.stdout,"Browser form navigation incomplete"
    assert seen==[("null",None),(origin,origin+"/")],seen
    print("PASS: actual Chromium form submission reproduced null Origin under no-referrer; strict-origin preserves only origin and passes exact-origin check")
finally:
    sender.shutdown(); receiver.shutdown()
