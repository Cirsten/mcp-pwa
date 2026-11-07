/* Service worker: makes the app open and run offline.
 * App files: network first (so updates arrive), cached copy when offline.
 * Python runtime (vendor/): cached forever once downloaded (the folder name carries the version).
 * GitHub, Vercel functions and the website are never cached here. */
const SHELL = "mcp-shell-v2";
const VENDOR = "mcp-vendor-pyodide-0.27.7";
const SHELL_FILES = ["./", "index.html", "styles.css", "app.js", "worker.js", "runner.py", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.open(VENDOR).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
});
