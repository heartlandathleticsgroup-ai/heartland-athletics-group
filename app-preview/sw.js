/* H.A.G. public app preview PWA shell. No staff or submitted personal data is cached. */
const CACHE_NAME='hag-public-preview-shell-v1';
const SHELL=['/app-preview/','/app-preview/manifest.webmanifest','/app-preview/icon.svg'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(n=>n.startsWith('hag-public-preview-')&&n!==CACHE_NAME).map(n=>caches.delete(n)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
 const url=new URL(request.url);
 if(!SHELL.includes(url.pathname)&&url.pathname!=='/app-preview/index.html')return;
 event.respondWith(fetch(request).then(response=>{
   if(response.ok){
     const snapshot=response.clone();
     event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(request,snapshot)));
   }
   return response;
 }).catch(()=>caches.match(request).then(cached=>cached||new Response(
   '<!doctype html><title>H.A.G. offline</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:28px"><h1>H.A.G. is offline</h1><p>Reconnect to view current programs, News and events.</p></body>',
   {headers:{'content-type':'text/html; charset=utf-8'}}))));
});
