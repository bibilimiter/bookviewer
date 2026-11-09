// BookViewer のサービスワーカー：画面の部品と pdf.js をしまっておき、ネットがなくても開けるようにする
// 日本語の PDF でよく使う文字の表（cmaps）も最初にしまう。ほかの表は、使ったときにしまう
// 画面の部品を直したときは、VERSION の数を上げる（新しいものに入れかわる）
const VERSION = 'bv-v18';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'listen.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png',
  'cmaps/UniJIS-UCS2-H.bcmap', 'cmaps/UniJIS-UCS2-V.bcmap', 'cmaps/UniJIS-UTF16-H.bcmap', 'cmaps/UniJIS-UTF16-V.bcmap', 'cmaps/Adobe-Japan1-UCS2.bcmap',
  'cmaps/90ms-RKSJ-H.bcmap', 'cmaps/90ms-RKSJ-V.bcmap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネットにつながっていれば新しいものを使い、つながらなければしまっておいたものを使う
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const req = url.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request;
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
