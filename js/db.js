// Capa de persistencia local basada en IndexedDB.
// Almacenes de datos: projects, members, sheets (planos), tasks, files (blobs de imágenes).
// Almacenes internos: outbox (cambios pendientes de sincronizar) y meta (cursores, etc.).

let dbName = 'obraplan';
const VERSION = 3;
export const STORES = ['projects', 'members', 'sheets', 'tasks', 'files', 'markups'];

let dbPromise;

/** Cambia la base de datos local (una por usuario en modo servidor). Debe llamarse antes de usarla. */
export function configureDB(name) {
  if (name === dbName) return;
  dbName = name;
  dbPromise = null;
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: 'id' });
        if (name !== 'projects') os.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Ejecuta `fn(tx)` en una transacción sobre uno o varios almacenes y devuelve lo que retorne `fn` (o el resultado de su petición). */
function run(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        const out = fn(tx);
        tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

// ---------- Seguimiento de cambios para la sincronización ----------
let tracking = false;
let onLocalChange = null;

/** Activa el registro de cambios locales en la bandeja de salida (modo servidor). */
export function enableTracking(callback) {
  tracking = true;
  onLocalChange = callback;
}

const outboxEntry = (store, id, projectId, op) => ({ key: `${store}:${id}`, store, id, projectId, op, at: Date.now() + Math.random() });

export const db = {
  get: (store, id) => run(store, 'readonly', (tx) => tx.objectStore(store).get(id)),
  all: (store) => run(store, 'readonly', (tx) => tx.objectStore(store).getAll()),
  byProject: (store, projectId) => run(store, 'readonly', (tx) => tx.objectStore(store).index('projectId').getAll(projectId)),

  async put(store, obj) {
    if (!tracking || !STORES.includes(store)) {
      await run(store, 'readwrite', (tx) => tx.objectStore(store).put(obj));
      return obj;
    }
    obj._rev = Date.now();
    await run([store, 'outbox'], 'readwrite', (tx) => {
      tx.objectStore(store).put(obj);
      tx.objectStore('outbox').put(outboxEntry(store, obj.id, store === 'projects' ? obj.id : obj.projectId, 'put'));
    });
    onLocalChange?.();
    return obj;
  },

  async del(store, id) {
    if (!tracking || !STORES.includes(store)) return run(store, 'readwrite', (tx) => tx.objectStore(store).delete(id));
    await run([store, 'outbox'], 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      os.get(id).onsuccess = (e) => {
        const obj = e.target.result;
        os.delete(id);
        if (obj) tx.objectStore('outbox').put(outboxEntry(store, id, store === 'projects' ? id : obj.projectId, 'del'));
      };
    });
    onLocalChange?.();
  },

  // Escrituras que llegan del servidor: no generan cambios pendientes.
  applyRemote: (store, obj) => run(store, 'readwrite', (tx) => tx.objectStore(store).put(obj)),
  removeRemote: (store, id) => run(store, 'readwrite', (tx) => tx.objectStore(store).delete(id)),

  outboxAll: () => run('outbox', 'readonly', (tx) => tx.objectStore('outbox').getAll()),
  outboxCount: () => run('outbox', 'readonly', (tx) => tx.objectStore('outbox').count()),
  /** Elimina una entrada enviada, salvo que haya cambiado mientras tanto (se volverá a enviar). */
  outboxAck: (entry) =>
    run('outbox', 'readwrite', (tx) => {
      const os = tx.objectStore('outbox');
      os.get(entry.key).onsuccess = (e) => {
        if (e.target.result && e.target.result.at === entry.at) os.delete(entry.key);
      };
    }),
  metaGet: (key) => run('meta', 'readonly', (tx) => tx.objectStore('meta').get(key)).then((r) => r?.value),
  metaSet: (key, value) => run('meta', 'readwrite', (tx) => tx.objectStore('meta').put({ key, value })),
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Archivos (blobs) ----------
const urlCache = new Map();
let remoteFileFetcher = null;

/** Permite descargar del servidor los archivos de los que sólo se conocen los metadatos. */
export function setRemoteFileFetcher(fn) {
  remoteFileFetcher = fn;
}

export async function saveFile(projectId, blob, name = '') {
  const file = { id: uid(), projectId, blob, type: blob.type, name, size: blob.size, createdAt: Date.now() };
  await db.put('files', file);
  return file.id;
}

export async function fileUrl(id) {
  if (!id) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const f = await db.get('files', id);
  if (!f) return '';
  if (!f.blob) {
    const blob = remoteFileFetcher ? await remoteFileFetcher(id).catch(() => null) : null;
    if (!blob) return '';
    f.blob = blob;
    await db.applyRemote('files', f);
  }
  const url = URL.createObjectURL(f.blob);
  urlCache.set(id, url);
  return url;
}

/** Devuelve el contenido (Blob) de un archivo, descargándolo del servidor si hace falta. */
export async function fileBlob(id) {
  if (!id) return null;
  if (!(await fileUrl(id))) return null;
  return (await db.get('files', id))?.blob || null;
}

export function forgetFileUrl(id) {
  if (urlCache.has(id)) {
    URL.revokeObjectURL(urlCache.get(id));
    urlCache.delete(id);
  }
}

export async function deleteFile(id) {
  forgetFileUrl(id);
  await db.del('files', id);
}

/** Borra del dispositivo todos los datos de un proyecto sin generar cambios pendientes. */
export async function removeProjectLocal(projectId) {
  for (const store of STORES.filter((s) => s !== 'projects')) {
    for (const it of await db.byProject(store, projectId)) {
      if (store === 'files') forgetFileUrl(it.id);
      await db.removeRemote(store, it.id);
    }
  }
  await db.removeRemote('projects', projectId);
}

// ---------- Proyectos ----------
export const DEFAULT_CATEGORIES = [
  'General', 'Albañilería', 'Estructura', 'Electricidad', 'Fontanería',
  'Climatización', 'Carpintería', 'Pintura', 'Seguridad', 'Acabados',
];

export async function createProject(data) {
  const project = {
    id: uid(),
    name: data.name,
    code: data.code || '',
    address: data.address || '',
    client: data.client || '',
    categories: data.categories || [...DEFAULT_CATEGORIES],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('projects', project);
  return project;
}

export async function deleteProject(projectId) {
  if (tracking) {
    // El servidor elimina todo el contenido al borrar el proyecto.
    await removeProjectLocal(projectId);
    await run('outbox', 'readwrite', (tx) => tx.objectStore('outbox').put(outboxEntry('projects', projectId, projectId, 'del')));
    onLocalChange?.();
    return;
  }
  for (const store of STORES.filter((s) => s !== 'projects')) {
    for (const it of await db.byProject(store, projectId)) {
      if (store === 'files') await deleteFile(it.id);
      else await db.del(store, it.id);
    }
  }
  await db.del('projects', projectId);
}

// ---------- Tareas ----------
export const STATUSES = [
  { id: 'p1', label: 'Prioridad alta', short: 'Alta', color: '#dc2626', open: true },
  { id: 'p2', label: 'Prioridad media', short: 'Media', color: '#ea580c', open: true },
  { id: 'p3', label: 'Prioridad baja', short: 'Baja', color: '#2563eb', open: true },
  { id: 'done', label: 'Completada', short: 'Completada', color: '#16a34a', open: false },
  { id: 'verified', label: 'Verificada', short: 'Verificada', color: '#475569', open: false },
];
export const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];

export async function createTask(project, data, author = '') {
  // Número consecutivo por proyecto. Si dos personas crean tareas sin conexión a la vez,
  // el servidor renumera la que llegue en segundo lugar.
  const existing = await db.byProject('tasks', project.id);
  const number = existing.reduce((max, t) => Math.max(max, t.number || 0), 0) + 1;
  const now = Date.now();
  const task = {
    id: uid(),
    projectId: project.id,
    number,
    title: data.title || 'Tarea sin título',
    status: data.status || 'p2',
    category: data.category || project.categories[0] || 'General',
    assigneeId: data.assigneeId || '',
    startDate: data.startDate || '',
    dueDate: data.dueDate || '',
    location: data.location || '',
    description: data.description || '',
    tags: data.tags || [],
    sheetId: data.sheetId || '',
    x: data.x ?? null,
    y: data.y ?? null,
    checklist: data.checklist || [],
    photoIds: data.photoIds || [],
    comments: [],
    activity: [{ at: now, by: author, text: 'Tarea creada' }],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  await db.put('tasks', task);
  return task;
}

export async function saveTask(task, activityText, author = '') {
  task.updatedAt = Date.now();
  if (activityText) task.activity.push({ at: task.updatedAt, by: author, text: activityText });
  await db.put('tasks', task);
  return task;
}

export function isOverdue(task) {
  if (!task.dueDate || !statusOf(task.status).open) return false;
  return task.dueDate < todayISO();
}

export function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// ---------- Copia de seguridad ----------
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function exportProject(projectId) {
  const out = { format: 'obraplan-backup', version: 1, exportedAt: new Date().toISOString() };
  out.project = await db.get('projects', projectId);
  for (const store of ['members', 'sheets', 'tasks', 'markups']) out[store] = await db.byProject(store, projectId);
  const files = await db.byProject('files', projectId);
  out.files = [];
  for (const f of files) {
    if (!f.blob) {
      // Archivo sincronizado que aún no se había descargado en este dispositivo.
      await fileUrl(f.id);
      f.blob = (await db.get('files', f.id))?.blob;
      if (!f.blob) continue;
    }
    out.files.push({ id: f.id, name: f.name, type: f.type, data: await blobToDataURL(f.blob) });
  }
  return out;
}

export async function importProject(backup) {
  if (!backup || backup.format !== 'obraplan-backup') throw new Error('Archivo de copia no válido');
  // Se reasignan los IDs para poder importar varias veces sin colisiones.
  const map = new Map();
  const remap = (id) => {
    if (!id) return id;
    if (!map.has(id)) map.set(id, uid());
    return map.get(id);
  };
  const project = { ...backup.project, id: remap(backup.project.id), updatedAt: Date.now() };
  const pid = project.id;
  await db.put('projects', project);
  for (const f of backup.files || []) {
    const blob = await (await fetch(f.data)).blob();
    await db.put('files', { id: remap(f.id), projectId: pid, blob, type: f.type, name: f.name, createdAt: Date.now() });
  }
  for (const m of backup.members || []) await db.put('members', { ...m, id: remap(m.id), projectId: pid });
  for (const s of backup.sheets || []) {
    const files = (v) => ({ fileId: remap(v.fileId), thumbId: remap(v.thumbId), pdfFileId: remap(v.pdfFileId) });
    await db.put('sheets', { ...s, id: remap(s.id), projectId: pid, ...files(s), versions: (s.versions || []).map((v) => ({ ...v, ...files(v) })) });
  }
  for (const m of backup.markups || []) {
    await db.put('markups', { ...m, id: remap(m.id), projectId: pid, sheetId: remap(m.sheetId) });
  }
  for (const t of backup.tasks || []) {
    await db.put('tasks', {
      ...t,
      id: remap(t.id),
      projectId: pid,
      sheetId: remap(t.sheetId),
      assigneeId: remap(t.assigneeId),
      photoIds: (t.photoIds || []).map(remap),
    });
  }
  return project;
}
