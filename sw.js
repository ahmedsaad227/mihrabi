/* MIHRABI service worker — offline app shell + prayer plan for background sync */
const CACHE = 'mihrabi-v6';
const PLAN = 'mihrabi-plan';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PLAN).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

/* ---- prayer alerts from Periodic Background Sync (Android Chrome, installed) ---- */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'mihrabi-prayer') e.waitUntil(checkPrayers());
});

async function checkPrayers() {
  const cache = await caches.open(PLAN);
  const res = await cache.match('/plan.json');
  if (!res) return;
  const plan = await res.json();
  const now = Date.now();
  const metaRes = await cache.match('/meta.json');
  const meta = metaRes ? await metaRes.json() : { fired: [] };
  const fired = new Set(meta.fired || []);
  let changed = false;
  for (const p of plan.times || []) {
    if (p.at > now || now - p.at > 3 * 3600 * 1000) continue;
    const key = p.date + ':' + p.key;
    if (fired.has(key)) continue;
    fired.add(key);
    changed = true;
    await self.registration.showNotification('مِحرابي — ' + p.label, {
      body: p.timeLabel + (plan.city ? ' · ' + plan.city : ''),
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: key,
      data: { url: './#/prayer' }
    });
  }
  if (changed) {
    await cache.put('/meta.json', new Response(JSON.stringify({ fired: [...fired].slice(-60) })));
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('./#/prayer');
  }));
});
