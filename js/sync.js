// Cuentas y sincronización con el servidor de ObraPlan.
// Si la app se sirve sin servidor (hosting estático, archivo local), todo funciona en modo local.

import { db, configureDB, enableTracking, setRemoteFileFetcher, removeProjectLocal, forgetFileUrl } from './db.js';
import { setUserOverride } from './ui.js';

const SESSION_KEY = 'obraplan.session';
const SYNC_INTERVAL = 15000;
const BATCH = 150;

export const session = {
  mode: 'local', // 'local' | 'server'
  user: null,
  token: null,
  roles: {}, // projectId -> 'admin' | 'miembro' | 'seguidor'
  status: 'idle', // 'idle' | 'syncing' | 'ok' | 'offline' | 'error'
  pending: 0,
  lastSync: null,
};

const listeners = new Set();
export function onSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (type, detail) => listeners.forEach((fn) => fn(type, detail));

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}
function persist() {
  try {
    if (session.token) localStorage.setItem(SESSION_KEY, JSON.stringify({ token: session.token, user: session.user, roles: session.roles }));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

// ---------- API ----------
export async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(`api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* respuesta sin JSON */
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.blob();
}

async function detectServer() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('api/health', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    return (await res.json()).app === 'obraplan';
  } catch {
    return false;
  }
}

/**
 * Decide el modo de trabajo al arrancar.
 * Devuelve 'local', 'server' (con sesión) o 'login' (hay servidor pero falta iniciar sesión).
 */
export async function initSession() {
  const saved = readSaved();
  if (saved?.token && saved.user) {
    // Con sesión guardada se trabaja en modo servidor aunque no haya conexión ahora mismo.
    Object.assign(session, { mode: 'server', token: saved.token, user: saved.user, roles: saved.roles || {} });
    startSync();
    return 'server';
  }
  if (await detectServer()) {
    session.mode = 'server';
    return 'login';
  }
  return 'local';
}

function acceptSession(data) {
  session.token = data.token;
  session.user = data.user;
  session.roles = Object.fromEntries((data.projects || []).map((p) => [p.id, p.role]));
  persist();
}

export async function login(email, password) {
  acceptSession(await api('/login', { method: 'POST', body: { email, password } }));
}
export async function register(name, email, password, invite) {
  acceptSession(await api('/register', { method: 'POST', body: { name, email, password, ...(invite ? { invite } : {}) } }));
}
/** Nueva contraseña con un código de recuperación o de restablecimiento. Inicia sesión al terminar. */
export async function recover(email, code, password) {
  const data = await api('/recover', { method: 'POST', body: { email, code, password } });
  acceptSession(data);
  return data;
}
/** Actualiza los datos de la cuenta guardados en este dispositivo (tras cambiar nombre o email). */
export function updateAccount(user, projects) {
  session.user = { ...session.user, ...user };
  if (projects) session.roles = Object.fromEntries(projects.map((p) => [p.id, p.role]));
  persist();
  setUserOverride(session.user.name);
}
/** Datos públicos de un enlace de invitación. */
export const inviteInfo = (token) => api(`/invite/${encodeURIComponent(token)}`);
/** Acepta una invitación con la sesión actual; devuelve el proyecto ({ id, role }). */
export async function acceptInvite(token) {
  const r = await api(`/invite/${encodeURIComponent(token)}/accept`, { method: 'POST' });
  session.roles = Object.fromEntries(r.projects.map((p) => [p.id, p.role]));
  persist();
  return r;
}
/** Cierra la sesión solo en este dispositivo, sin llamar al servidor (p. ej. tras borrar la cuenta). */
export function forgetSession() {
  session.token = null;
  persist();
  location.hash = '#/';
  location.reload();
}
export async function logout() {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* sin conexión: la sesión se descarta igualmente en este dispositivo */
  }
  session.token = null;
  persist();
  location.hash = '#/';
  location.reload();
}

// ---------- Roles ----------
/** Rol en un proyecto. Un proyecto recién creado y aún no sincronizado es del usuario (admin). */
export const roleOf = (projectId) => (session.mode === 'server' ? session.roles[projectId] || 'admin' : 'admin');
export const canEdit = (projectId) => roleOf(projectId) !== 'seguidor';
export const isAdmin = (projectId) => roleOf(projectId) === 'admin';
export const ROLE_LABELS = { admin: 'Administrador', miembro: 'Miembro', seguidor: 'Seguidor (solo lectura)' };

// ---------- Sincronización ----------
let running = false;
let again = false;
let timer = null;
let debounce = null;

function setStatus(status) {
  session.status = status;
  emit('status', session);
}

export function scheduleSync(delay = 800) {
  clearTimeout(debounce);
  debounce = setTimeout(syncNow, delay);
}

function startSync() {
  configureDB(`obraplan-u-${session.user.id}`);
  setUserOverride(session.user.name);
  enableTracking(() => {
    db.outboxCount().then((n) => {
      session.pending = n;
      emit('status', session);
    });
    scheduleSync();
  });
  setRemoteFileFetcher((id) => api(`/files/${encodeURIComponent(id)}`));
  timer = setInterval(syncNow, SYNC_INTERVAL);
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncNow());
  syncNow();
}

export async function syncNow() {
  if (session.mode !== 'server' || !session.token) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  setStatus('syncing');
  try {
    const entries = (await db.outboxAll()).sort((a, b) => a.at - b.at).slice(0, BATCH);
    const changes = [];
    const uploads = [];
    for (const e of entries) {
      if (e.op === 'del') {
        changes.push({ store: e.store, id: e.id, projectId: e.projectId, op: 'del' });
        continue;
      }
      const obj = await db.get(e.store, e.id);
      if (!obj) continue;
      const { blob, ...data } = obj;
      if (e.store === 'files' && blob) uploads.push({ entry: e, file: obj });
      changes.push({ store: e.store, id: e.id, projectId: e.projectId, op: 'put', rev: obj._rev, data });
    }

    const cursors = (await db.metaGet('cursors')) || {};
    const res = await api('/sync', { method: 'POST', body: { changes, cursors } });

    // Los archivos se suben después de los datos (el proyecto ya existe en el servidor).
    // Un archivo sólo sale de la bandeja cuando su contenido se ha subido.
    const uploaded = new Set();
    for (const { entry, file } of uploads) {
      try {
        await api(`/files/${encodeURIComponent(file.id)}`, { method: 'PUT', raw: file.blob, headers: { 'X-Project-Id': file.projectId, 'Content-Type': 'application/octet-stream' } });
        uploaded.add(entry.key);
      } catch (err) {
        if (!err.status) throw err; // sin conexión: se reintentará
        uploaded.add(entry.key); // rechazado por el servidor (permisos, tamaño): no se reintenta
      }
    }
    for (const e of entries) {
      if (e.store === 'files' && e.op === 'put' && uploads.some((u) => u.entry.key === e.key) && !uploaded.has(e.key)) continue;
      await db.outboxAck(e);
    }
    const stillPending = new Set((await db.outboxAll()).map((e) => e.key));

    let remote = 0;
    for (const c of res.changes) {
      const key = `${c.store}:${c.id}`;
      if (stillPending.has(key)) continue; // hay una edición local más reciente
      if (c.deleted) {
        if (c.store === 'files') forgetFileUrl(c.id);
        const had = await db.get(c.store, c.id);
        if (had) {
          await db.removeRemote(c.store, c.id);
          remote++;
        }
        continue;
      }
      const local = await db.get(c.store, c.id);
      const { blob, ...localData } = local || {};
      if (local && JSON.stringify(localData) === JSON.stringify(c.data)) continue; // eco de lo enviado
      await db.applyRemote(c.store, c.store === 'files' ? { ...c.data, blob } : c.data);
      remote++;
    }

    for (const pid of res.removed) {
      await removeProjectLocal(pid);
      emit('project-removed', pid);
      remote++;
    }
    session.roles = Object.fromEntries(res.projects.map((p) => [p.id, p.role]));
    persist();
    await db.metaSet('cursors', res.cursors);

    if (res.rejected.length) emit('rejected', res.rejected);
    if (remote) emit('remote-change', remote);
    session.lastSync = Date.now();
    session.pending = await db.outboxCount();
    if (session.pending > 0 && entries.length === BATCH) again = true;
    setStatus('ok');
  } catch (err) {
    session.pending = await db.outboxCount().catch(() => session.pending);
    if (err.status === 401) {
      session.token = null;
      persist();
      clearInterval(timer);
      emit('auth-expired');
    }
    setStatus(err.status ? 'error' : 'offline');
  } finally {
    running = false;
    if (again) {
      again = false;
      setTimeout(syncNow, 50);
    }
  }
}
