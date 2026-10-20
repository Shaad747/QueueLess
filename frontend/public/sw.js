// Cache only public offline/help assets. Never store API, account, or token data.
const CACHE = 'queueless-public-v1'
const PUBLIC = ['/offline.html','/offline.css','/app-192.png','/app-512.png','/apple-touch-icon.png']
self.addEventListener('install',(event)=>{
  event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(PUBLIC)).then(()=>self.skipWaiting()))
})
self.addEventListener('activate',(event)=>{
  event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key.startsWith('queueless-public-')&&key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim()))
})
self.addEventListener('fetch',(event)=>{
  const url=new URL(event.request.url)
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')))
  }else if(PUBLIC.includes(url.pathname)){
    event.respondWith(caches.match(event.request).then((cached)=>cached||fetch(event.request)))
  }
})
