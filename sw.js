// Service worker: permite usar la app sin conexión (los datos ya viven en IndexedDB)
// y muestra los avisos de tareas pendientes (sincronización periódica en segundo plano).
importScripts('js/reminders-core.js');
const CACHE = 'obraplan-v35';
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
  'js/folders.js',
  'js/loupe.js',
  'js/reminders.js',
  'js/reminders-core.js',
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
  'js/views/account.js',
  'js/icons.js',
  'js/linkpins.js',
  'js/video.js',
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
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('obraplan-v')).map((k) => caches.delete(k)))).then(() => self.clients.claim())
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
  // Archivos de la app: siempre se pregunta al servidor si hay versión nueva (GitHub Pages permite
  // guardarlos 10 min en la caché del navegador y las actualizaciones tardaban en llegar).
  // La comprobación es ligera: si no cambió, el servidor responde «304 sin cambios».
  const sameOrigin = url.origin === self.location.origin;
  e.respondWith(
    fetch(request, sameOrigin ? { cache: 'no-cache' } : undefined)
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

// ---------- Avisos de tareas ----------
const BASE = new URL('./', self.location.href).href;

// Chrome (app instalada) despierta al service worker de vez en cuando para comprobar si toca avisar
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'obraplan-reminders') e.waitUntil(self.ObraReminders.check(self.registration, BASE));
});

// Al tocar un aviso: abrir (o enfocar) la app en la tarea
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || BASE;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => c.url.startsWith(BASE));
      if (win) return win.focus().then((w) => (w || win).navigate(url)).catch(() => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    })
  );
});
