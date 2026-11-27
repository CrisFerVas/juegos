// Service worker: permite usar la app sin conexión (los datos ya viven en IndexedDB).
const CACHE = 'obraplan-v11';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'css/styles.css',
  'js/app.js',
  'js/db.js',
  'js/ui.js',
  'js/media.js',
  'js/hires.js',
  'js/markup.js',
  'js/exportplan.js',
  'js/compare.js',
  'js/photopins.js',
  'js/camera.js',
  'js/photoannotate.js',
  'js/forms.js',
  'js/signature.js',
  'js/views/forms.js',
  'js/views/formDetail.js',
  'js/views/templateEditor.js',
  'js/sync.js',
  'js/views/auth.js',
  'js/views/projects.js',
  'js/views/dashboard.js',
  'js/views/plans.js',
  'js/views/viewer.js',
  'js/views/tasks.js',
  'js/views/taskDetail.js',
  'js/views/team.js',
  'js/views/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Red primero (para recibir actualizaciones) y caché como respaldo sin conexión.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // La API (datos y archivos de cada usuario) nunca se guarda en caché.
  if (url.pathname.includes('/api/')) return;
  const cacheable = url.origin === self.location.origin || url.hostname === 'cdnjs.cloudflare.com';
  if (!cacheable) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || (request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
