/* ============================================================
   PORTAL SEC. HACIENDA · SERVICE WORKER (MODO FRESCO)
   Solo el armazón (HTML, CSS, JS) y los medios del repo. NADA de datos:
   las llamadas a Apps Script, el CDN y el PSE no se tocan.

   Prefijos propios (todas las apps comparten botheart911.github.io):
     · 'portalhac-v…'       armazón; se estrena en cada publicación.
     · 'portalhacmedios-v1' imágenes y sonidos; no se borra al publicar.
   Nunca se tocan las cachés de otras apps.

   En cada apertura se pregunta version.js a la RED (con tiempo límite):
     · si cambió, esa apertura sale entera de la red, sin mezclar viejo;
     · si es la misma, el armazón sale de la caché de ESTA versión.
   ============================================================ */
importScripts('./version.js');

var CACHE_NAME = 'portalhac-v' + APP_VERSION;
var CACHE_MEDIOS = 'portalhacmedios-v1';
var RUTA_VERSION = new URL('./version.js', self.location.href).pathname;
var ESPERA_VERSION_MS = 3000;
var FRESCOS = {};

var ARMAZON = [
  './',
  './index.html',
  './css/portal.css',
  './js/portal.js',
  './version.js',
  './manifest.webmanifest',
  './img/icono-32.png',
  './img/icono-192.png',
  './img/escudo.webp',
  './img/fondo.webp'
];

function versionDeLaRed_() {
  return new Promise(function (listo) {
    var t = setTimeout(function () { listo(''); }, ESPERA_VERSION_MS);
    fetch(RUTA_VERSION + '?sw=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        clearTimeout(t);
        var m = /APP_VERSION\s*=\s*["']([^"']+)["']/.exec(String(txt || ''));
        listo(m ? m[1].trim() : '');
      })
      .catch(function () { clearTimeout(t); listo(''); });
  });
}
function deMiCache_(req) {
  return caches.open(CACHE_NAME).then(function (c) { return c.match(req); });
}
function guardar_(req, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  var copia = res.clone();
  caches.open(CACHE_NAME).then(function (c) { return c.put(req, copia); }).catch(function () {});
}

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return Promise.all(ARMAZON.map(function (u) {
      return fetch(new Request(u, { cache: 'reload' }))
        .then(function (res) { if (res && res.ok) return cache.put(u, res); })
        .catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return (k.indexOf('portalhac-v') === 0 && k !== CACHE_NAME) ||
             (k.indexOf('portalhacmedios-') === 0 && k !== CACHE_MEDIOS);
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;               /* CDN, Apps Script, PSE: no se tocan */

  if (url.pathname === RUTA_VERSION) {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(function () { return deMiCache_(req); }));
    return;
  }

  /* Medios del repo: caché primero (no cambian; si cambian, cambia el nombre).
     El video pide rangos: se deja pasar a la red para no romper el Range. */
  if (/\/(img|sound)\//.test(url.pathname)) {
    if (req.headers.has('range')) return;
    event.respondWith(caches.open(CACHE_MEDIOS).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          if (res && res.ok && res.status === 200) c.put(req, res.clone()).catch(function () {});
          return res;
        });
      });
    }).catch(function () { return fetch(req); }));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(versionDeLaRed_().then(function (red) {
      var fresca = !!red && red !== String(APP_VERSION);
      if (event.resultingClientId) FRESCOS[event.resultingClientId] = fresca;
      return fetch(req, { cache: fresca ? 'reload' : 'no-cache' })
        .then(function (res) { if (!fresca) guardar_(req, res); return res; })
        .catch(function () { return deMiCache_(req).then(function (h) { return h || deMiCache_('./index.html'); }); });
    }));
    return;
  }

  if (/\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    var fresca = FRESCOS[event.clientId];
    if (fresca === true) {
      event.respondWith(fetch(req, { cache: 'reload' }).catch(function () { return deMiCache_(req); }));
    } else if (fresca === false) {
      event.respondWith(deMiCache_(req).then(function (hit) {
        return hit || fetch(req, { cache: 'no-cache' }).then(function (res) { guardar_(req, res); return res; });
      }));
    } else {
      event.respondWith(fetch(req, { cache: 'no-cache' })
        .then(function (res) { guardar_(req, res); return res; })
        .catch(function () { return deMiCache_(req); }));
    }
    return;
  }

  event.respondWith(fetch(req).catch(function () { return deMiCache_(req); }));
});
