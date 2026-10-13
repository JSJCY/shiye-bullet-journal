'use strict';
const CACHE_NAME='shiye-shell-v0.3.0';
const ASSETS=['./','./index.html','./styles.css','./app.js','./journal-core.js','./sync-model.js','./config.js','./provider.js','./sync-engine.js','./sync-ui.js','./cloudbase-adapter.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('shiye-shell-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||event.request.headers.has('Authorization'))return;
 if(event.request.mode==='navigate'){
  event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(c=>c.put('./index.html',copy)));}return response;}).catch(()=>caches.match('./index.html')));return;
 }
 const allowed=ASSETS.some(p=>new URL(p,self.registration.scope).pathname===url.pathname)||url.pathname.endsWith('/cloudbase-adapter.js');if(!allowed)return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(c=>c.put(event.request,copy)));}return response;}).catch(()=>caches.match(event.request)));
});
