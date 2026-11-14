// TRADESK service worker — makes the app installable and lets it open offline.
// Deliberately conservative: market data and API calls always go to the network
// (never served stale from cache); only the app shell is cached as an offline fallback.
const SHELL = "tradesk-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // data: network only
  if (req.mode === "navigate") {
    // Network first so a new deploy is picked up immediately; cached shell only when offline
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put("/", copy));
        return res;
      }).catch(() => caches.match("/"))
    );
  }
});

// Server-sent alerts (stop hit, price level, signal change) — arrive even when the app is closed
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: "TRADESK", body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "TRADESK alert", {
    body: data.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: data.tag || "tradesk", data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const w = wins.find((x) => "focus" in x);
      return w ? w.focus() : self.clients.openWindow("/");
    })
  );
});
