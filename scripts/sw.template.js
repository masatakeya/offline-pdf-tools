const VERSION = "__VERSION__";
const PRECACHE_URLS = ["__PRECACHE_URLS__"];
const CACHE = `pdf-tools-${VERSION}`;

self.addEventListener("install", (event) => {
  // 新しい版は待機状態にしておき、画面の「更新」ボタンで切り替える
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("pdf-tools-") && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./", { ignoreSearch: true }).then((cached) => cached || fetch(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req))
  );
});
