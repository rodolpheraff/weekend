var VERSION = "v5";
var CACHE = "weekend-" + VERSION;
var ASSETS = ["./", "index.html", "manifest.json", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(ASSETS.map(function (a) { return c.add(a).catch(function () {}); }));
  }));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  // Tuiles de carte, meteo, guides : toujours le reseau
  if (/openstreetmap|open-meteo|wiki/.test(url.hostname)) return;

  // Page et donnees de vols : reseau d'abord, cache si hors ligne
  if (e.request.mode === "navigate" || url.pathname.indexOf("/data/") !== -1) {
    var key = e.request.mode === "navigate" ? "index.html" : "data/weekends.json";
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(key, copy); });
        return res;
      }).catch(function () { return caches.match(key); })
    );
    return;
  }

  // Le reste (polices, icones, photos) : cache d'abord
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (res) {
        if (res && (res.status === 200 || res.type === "opaque")) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      });
    })
  );
});
