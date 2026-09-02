const CACHE_VERSION = "mtk8autp";
const CACHE_PREFIX = "pathology-mobile-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const SHELL = ["./", "./index.html", "./styles.css", "./tnm.css", "./polish.css", "./app.js", "./mobile-utils.mjs", "./catalog.json", "./manifest.webmanifest", "./icons/icon.svg"];
const SCOPE_PATH = new URL("./", self.location.href).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

function sameOrigin(request) {
  try { return new URL(request.url).origin === self.location.origin; } catch { return false; }
}

function scopedPath(url) {
  return url.pathname.startsWith(SCOPE_PATH) ? `/${url.pathname.slice(SCOPE_PATH.length)}` : url.pathname;
}

function isBlockedPath(pathname) {
  return pathname.includes("/media/") || pathname.includes("/assets/images/") || pathname.startsWith("/api/") || pathname.endsWith(".svs") || pathname.endsWith(".ndpi");
}

function isDetailOrSearch(pathname) {
  return /^\/(?:diseases|cases|tnm|search)\//u.test(pathname);
}

function matchCache(request) {
  return caches.match(request).then((exact) => exact || caches.match(request, { ignoreSearch: true }));
}

function isVersionedRequest(url) { return url.searchParams.has("v"); }

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !sameOrigin(request)) return;
  const url = new URL(request.url);
  const pathname = scopedPath(url);
  if (isBlockedPath(pathname)) return;
  if (isDetailOrSearch(pathname)) {
    const fetchAndCache = () => fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    });
    const response = isVersionedRequest(url)
      ? fetchAndCache().catch(() => matchCache(request))
      : matchCache(request).then((cached) => cached || fetchAndCache());
    event.respondWith(response.catch(() => matchCache(request).then((cached) => cached || new Response("该资料尚未缓存", { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } }))));
    return;
  }
  event.respondWith(fetch(request).then((response) => {
    if (response.ok && (url.pathname.endsWith("/") || /\.(?:html|css|js|mjs|json|webmanifest|svg)$/u.test(url.pathname))) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  }).catch(() => matchCache(request).then((cached) => cached || caches.match("./index.html", { ignoreSearch: true }))));
});
