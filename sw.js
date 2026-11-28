/* Mijn budget – zorgt dat de app ook zonder internet opent */
const CACHE = 'mijnbudget-v80';
const LIB = 'mijnbudget-lib-1';  // grote bibliotheken (PDF- en bonlezer), blijven bewaard bij een update
const GEDEELD = 'duppie-gedeeld'; // bestand dat je vanuit een andere app met Duppie deelt (Android)
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LIB && k !== GEDEELD).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Delen naar Duppie: bewaar het bestand even en open de app, die het daarna oppakt
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/gedeeld')) {
    e.respondWith((async () => {
      try {
        const fd = await req.formData(), f = fd.get('bestand');
        if (f && typeof f !== 'string') {
          const c = await caches.open(GEDEELD);
          await c.put('gedeeld-bestand', new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-naam': encodeURIComponent(f.name || 'bestand') } }));
        }
      } catch (err) {}
      return Response.redirect('./?gedeeld=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Lettertypes: eerst uit de opslag
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Bibliotheken veranderen bijna nooit en zijn groot: eerst uit de opslag, zodat ze niet steeds opnieuw downloaden
  if (url.pathname.includes('/lib/')) {
    e.respondWith(caches.open(LIB).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res;
    }));
    return;
  }
  // Eigen bestanden: eerst internet (zodat updates binnenkomen), anders de opgeslagen versie
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      return (await c.match(req)) || (req.mode === 'navigate' ? await c.match('./index.html') : Response.error());
    }
  })());
});
