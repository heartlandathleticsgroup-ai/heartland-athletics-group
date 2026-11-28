from html.parser import HTMLParser
from pathlib import Path
class Page(HTMLParser):
    def __init__(self): super().__init__(); self.tags=[]
    def handle_starttag(self,t,a): self.tags.append((t,dict(a)))
for p in ('subscribe','privacy','terms','sms-terms'):
    src=Path(p+'/index.html').read_text()
    h=Page();h.feed(src)
    assert not any(t in ('script','form','iframe') for t,a in h.tags)
    assert all('disabled' in a and 'checked' not in a for t,a in h.tags if t in ('input','button','select','textarea'))
    assert all(not any(k.startswith('on') for k in a) for t,a in h.tags)
    assert "connect-src 'none'" in src and "form-action 'none'" in src and "script-src 'none'" in src
    for t,a in h.tags:
        if t in ('img','link') and (url:=a.get('src',a.get('href',''))).startswith('/'): assert Path(url[1:]).exists(),url
    for u in ('/privacy/','/sms-terms/','/subscribe/'): assert u in src
s=Path('subscribe/index.html').read_text()
for term in ('(833) 947-0815','JOIN','15 minutes','not open','Message frequency varies','Message and data rates may apply','Reply STOP','HELP','not a condition of purchase','18 years old','recurring automated marketing text messages'):
    assert term in s,term
assert 'Text messaging originator opt-in data and consent will not be sold or shared' in Path('privacy/index.html').read_text()
print('PASS: static reviewer pages, no form or scripts, no submissions or data collection, visible consent and linked policies')
