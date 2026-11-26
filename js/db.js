// Capa de persistencia local basada en IndexedDB.
// Almacenes: projects, members, sheets (planos), tasks, files (blobs de imágenes).

const DB_NAME = 'obraplan';
const VERSION = 1;
export const STORES = ['projects', 'members', 'sheets', 'tasks', 'files'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: 'id' });
        if (name !== 'projects') os.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const db = {
  get: (store, id) => run(store, 'readonly', (os) => os.get(id)),
  all: (store) => run(store, 'readonly', (os) => os.getAll()),
  byProject: (store, projectId) =>
    run(store, 'readonly', (os) => os.index('projectId').getAll(projectId)),
  put: (store, obj) => run(store, 'readwrite', (os) => os.put(obj)).then(() => obj),
  del: (store, id) => run(store, 'readwrite', (os) => os.delete(id)),
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Archivos (blobs) ----------
const urlCache = new Map();

export async function saveFile(projectId, blob, name = '') {
  const file = { id: uid(), projectId, blob, type: blob.type, name, createdAt: Date.now() };
  await db.put('files', file);
  return file.id;
}

export async function fileUrl(id) {
  if (!id) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const f = await db.get('files', id);
  if (!f) return '';
  const url = URL.createObjectURL(f.blob);
  urlCache.set(id, url);
  return url;
}

export async function deleteFile(id) {
  if (urlCache.has(id)) {
    URL.revokeObjectURL(urlCache.get(id));
    urlCache.delete(id);
  }
  await db.del('files', id);
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
    taskSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('projects', project);
  return project;
}

export async function deleteProject(projectId) {
  for (const store of STORES.filter((s) => s !== 'projects')) {
    const items = await db.byProject(store, projectId);
    for (const it of items) {
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
  project.taskSeq = (project.taskSeq || 0) + 1;
  project.updatedAt = Date.now();
  await db.put('projects', project);
  const now = Date.now();
  const task = {
    id: uid(),
    projectId: project.id,
    number: project.taskSeq,
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
  for (const store of ['members', 'sheets', 'tasks']) out[store] = await db.byProject(store, projectId);
  const files = await db.byProject('files', projectId);
  out.files = [];
  for (const f of files) {
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
    await db.put('sheets', { ...s, id: remap(s.id), projectId: pid, fileId: remap(s.fileId), thumbId: remap(s.thumbId) });
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
