// Servidor HTTP de ObraPlan: sirve la app web y la API de cuentas y sincronización.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, SYNCED_STORES, ROLES } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ENTRIES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};
const SESSION_TTL = 30 * 86400000;
const MAX_JSON = 25 * 1024 * 1024;
const MAX_FILE = 500 * 1024 * 1024; // planos PDF de gran formato
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Contraseñas ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- Fusión de tareas ----------
// Los comentarios y el historial se combinan para no perder lo escrito a la vez por varias personas.
function mergeTask(winner, other) {
  const out = { ...winner };
  const comments = new Map();
  for (const c of [...(other.comments || []), ...(winner.comments || [])]) comments.set(c.id || `${c.at}|${c.text}`, c);
  out.comments = [...comments.values()].sort((a, b) => a.at - b.at);
  const activity = new Map();
  for (const a of [...(other.activity || []), ...(winner.activity || [])]) activity.set(`${a.at}|${a.text}`, a);
  out.activity = [...activity.values()].sort((a, b) => a.at - b.at);
  return out;
}

export function createApp({ dataDir, log = () => {} }) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const store = openStore(path.join(dataDir, 'obraplan.db'));
  const { q } = store;
  const attempts = new Map(); // límite de intentos de acceso por IP

  // ---------- Utilidades HTTP ----------
  const send = (res, status, body, headers = {}) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, 'El contenido es demasiado grande'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJSON(req) {
    const buf = await readBody(req, MAX_JSON);
    try {
      return buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      throw new HttpError(400, 'JSON no válido');
    }
  }

  function throttle(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60000);
    if (list.length >= 30) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
    list.push(now);
    attempts.set(ip, list);
  }

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'Inicia sesión para continuar');
    const s = q.session.get(token);
    if (!s || Date.now() - s.last_seen > SESSION_TTL) throw new HttpError(401, 'La sesión ha caducado');
    if (Date.now() - s.last_seen > 60000) q.touchSession.run(Date.now(), token);
    const user = q.userById.get(s.user_id);
    if (!user) throw new HttpError(401, 'Usuario no encontrado');
    return { user, token };
  }

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });
  const rolesMap = (userId) => new Map(q.rolesOf.all(userId).map((r) => [r.project_id, r.role]));
  const projectsList = (userId) => q.rolesOf.all(userId).map((r) => ({ id: r.project_id, role: r.role }));

  function newSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, user.id, Date.now(), Date.now());
    return { token, user: publicUser(user), projects: projectsList(user.id) };
  }

  function requireRole(userId, projectId, roles) {
    const r = q.role.get(projectId, userId);
    if (!r) throw new HttpError(404, 'Proyecto no encontrado');
    if (!roles.includes(r.role)) throw new HttpError(403, 'No tienes permiso para esta acción');
    return r.role;
  }

  const canWrite = (role, store) =>
    role === 'admin' || (role === 'miembro' && store !== 'projects');

  // ---------- Archivos ----------
  /** Guarda la subida directamente en disco (sin cargarla en memoria) y la mueve a su sitio al terminar. */
  function saveUpload(req, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.part`;
    return new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(tmp);
      const fail = (err) => {
        out.destroy();
        fs.rmSync(tmp, { force: true });
        reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE) {
          req.unpipe(out);
          req.resume();
          fail(new HttpError(413, 'El archivo supera el tamaño máximo (500 MB)'));
        }
      });
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (size > MAX_FILE) return;
        fs.renameSync(tmp, dest);
        resolve(size);
      });
      req.pipe(out);
    });
  }

  const filePath = (projectId, id) => path.join(dataDir, 'files', projectId, id);
  function removeProjectFiles(projectId) {
    fs.rmSync(path.join(dataDir, 'files', projectId), { recursive: true, force: true });
  }

  // ---------- Sincronización ----------
  function handleSync(user, body) {
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const cursors = body.cursors && typeof body.cursors === 'object' ? body.cursors : {};
    const roles = rolesMap(user.id);
    const rejected = [];
    const echo = new Set(); // documentos cuyo estado del servidor hay que devolver
    const now = Date.now();

    store.transaction(() => {
      for (const ch of changes) {
        if (!ch || !SYNCED_STORES.includes(ch.store) || !ID_RE.test(ch.id || '')) continue;
        const projectId = ch.store === 'projects' ? ch.id : ch.projectId;
        if (!ID_RE.test(projectId || '')) continue;
        const key = `${ch.store}:${ch.id}`;
        let role = roles.get(projectId);

        if (!role) {
          // Un proyecto nuevo lo crea quien lo sube, que pasa a ser administrador.
          const isNewProject = ch.store === 'projects' && ch.op === 'put' && !q.projectKnown.get(projectId, projectId);
          if (!isNewProject) {
            rejected.push({ store: ch.store, id: ch.id, reason: 'sin acceso' });
            continue;
          }
          q.setMembership.run(projectId, user.id, 'admin', now);
          roles.set(projectId, 'admin');
          role = 'admin';
        }
        if (!canWrite(role, ch.store)) {
          rejected.push({ store: ch.store, id: ch.id, reason: 'sin permiso' });
          echo.add(key);
          continue;
        }

        const existing = q.doc.get(ch.store, ch.id);
        if (existing && existing.project_id !== projectId) {
          rejected.push({ store: ch.store, id: ch.id, reason: 'conflicto de identificador' });
          continue;
        }

        if (ch.op === 'del') {
          if (ch.store === 'projects') {
            q.deleteProjectDocs.run(projectId);
            q.deleteProjectMemberships.run(projectId);
            q.deleteProjectInvitations.run(projectId);
            q.upsertDoc.run('projects', projectId, projectId, null, now, 1, store.nextSeq(), user.id);
            removeProjectFiles(projectId);
            roles.delete(projectId);
          } else if (existing && !existing.deleted) {
            q.upsertDoc.run(ch.store, ch.id, projectId, null, now, 1, store.nextSeq(), user.id);
            if (ch.store === 'files') fs.rmSync(filePath(projectId, ch.id), { force: true });
          }
          continue;
        }

        // op === 'put'
        if (!ch.data || typeof ch.data !== 'object') continue;
        let data = { ...ch.data, id: ch.id };
        if (ch.store !== 'projects') data.projectId = projectId;
        delete data.blob;
        let rev = Number(ch.rev) || now;

        if (existing && existing.deleted) {
          echo.add(key); // no se resucitan documentos borrados
          continue;
        }
        if (existing) {
          const current = JSON.parse(existing.data);
          if (ch.store === 'tasks') {
            if (rev >= existing.rev) data = mergeTask(data, current);
            else {
              data = mergeTask(current, data);
              rev = existing.rev;
            }
            echo.add(key);
          } else if (rev < existing.rev) {
            echo.add(key); // la versión del servidor es más reciente
            continue;
          }
        } else if (ch.store === 'tasks' || ch.store === 'forms') {
          // Evita números duplicados cuando varias personas crean tareas o partes sin conexión.
          if (!Number.isInteger(data.number) || q.numberTaken.get(ch.store, projectId, ch.id, data.number)) {
            data.number = q.maxNumber.get(ch.store, projectId).n + 1;
            echo.add(key);
          }
        }
        q.upsertDoc.run(ch.store, ch.id, projectId, JSON.stringify(data), rev, 0, store.nextSeq(), user.id);
      }
    });

    // Cambios a devolver: todo lo posterior al cursor de cada proyecto del usuario.
    const out = [];
    const seen = new Set();
    const pushDoc = (d) => {
      const k = `${d.store}:${d.id}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ store: d.store, id: d.id, projectId: d.project_id, rev: d.rev, deleted: !!d.deleted, data: d.deleted ? null : JSON.parse(d.data) });
    };
    for (const [projectId] of roles) {
      const since = Number(cursors[projectId]) || 0;
      for (const d of q.changesSince.all(projectId, since)) pushDoc(d);
    }
    for (const k of echo) {
      const [s, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const d = q.doc.get(s, id);
      if (d && roles.has(d.project_id)) pushDoc(d);
      else if (!d) out.push({ store: s, id, deleted: true, data: null });
    }
    for (const r of rejected) {
      if (!seen.has(`${r.store}:${r.id}`) && !q.doc.get(r.store, r.id)) out.push({ store: r.store, id: r.id, deleted: true, data: null });
    }

    const seqNow = store.currentSeq();
    const newCursors = Object.fromEntries([...roles.keys()].map((p) => [p, seqNow]));
    const removed = Object.keys(cursors).filter((p) => !roles.has(p));
    return { changes: out, cursors: newCursors, rejected, removed, projects: projectsList(user.id) };
  }

  // ---------- Rutas de la API ----------
  async function api(req, res, url) {
    const method = req.method;
    const p = url.pathname.replace(/^\/api/, '');
    const parts = p.split('/').filter(Boolean);

    if (method === 'GET' && p === '/health') return send(res, 200, { ok: true, app: 'obraplan', version: 2 });

    if (method === 'POST' && p === '/register') {
      throttle(req);
      const body = await readJSON(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim().slice(0, 80);
      const password = String(body.password || '');
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Introduce un email válido');
      if (!name) throw new HttpError(400, 'Introduce tu nombre');
      if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
      if (q.userByEmail.get(email)) throw new HttpError(409, 'Ya existe una cuenta con ese email');
      const user = { id: crypto.randomUUID(), email, name };
      store.transaction(() => {
        q.insertUser.run(user.id, email, name, hashPassword(password), Date.now());
        // Las invitaciones pendientes se convierten en acceso al registrarse.
        for (const inv of q.invitationsForEmail.all(email)) {
          q.setMembership.run(inv.project_id, user.id, inv.role, Date.now());
          q.deleteInvitation.run(inv.project_id, email);
        }
      });
      log(`registro: ${email}`);
      return send(res, 201, newSession(user));
    }

    if (method === 'POST' && p === '/login') {
      throttle(req);
      const body = await readJSON(req);
      const email = String(body.email || '').trim().toLowerCase();
      const user = q.userByEmail.get(email);
      if (!user || !verifyPassword(String(body.password || ''), user.pass)) throw new HttpError(401, 'Email o contraseña incorrectos');
      return send(res, 200, newSession(user));
    }

    const { user, token } = authenticate(req);

    if (method === 'POST' && p === '/logout') {
      q.deleteSession.run(token);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/me') return send(res, 200, { user: publicUser(user), projects: projectsList(user.id) });
    if (method === 'POST' && p === '/sync') return send(res, 200, handleSync(user, await readJSON(req)));

    // /files/:id
    if (parts[0] === 'files' && parts.length === 2 && ID_RE.test(parts[1])) {
      const id = parts[1];
      if (method === 'PUT') {
        const projectId = String(req.headers['x-project-id'] || '');
        if (!ID_RE.test(projectId)) throw new HttpError(400, 'Falta el proyecto');
        const role = rolesMap(user.id).get(projectId);
        if (!role) throw new HttpError(404, 'Proyecto no encontrado');
        if (!canWrite(role, 'files')) throw new HttpError(403, 'No tienes permiso para subir archivos');
        const existing = q.doc.get('files', id);
        if (existing && existing.project_id !== projectId) throw new HttpError(409, 'Conflicto de identificador');
        const size = await saveUpload(req, filePath(projectId, id));
        return send(res, 200, { ok: true, size });
      }
      if (method === 'GET') {
        const d = q.doc.get('files', id);
        if (!d || d.deleted || !q.role.get(d.project_id, user.id)) throw new HttpError(404, 'Archivo no encontrado');
        const fp = filePath(d.project_id, id);
        if (!fs.existsSync(fp)) throw new HttpError(404, 'Archivo no disponible todavía');
        const meta = JSON.parse(d.data);
        res.writeHead(200, { 'Content-Type': meta.type || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
        fs.createReadStream(fp).pipe(res);
        return;
      }
    }

    // /projects/:id/access...
    if (parts[0] === 'projects' && ID_RE.test(parts[1] || '') && parts[2] === 'access') {
      const projectId = parts[1];
      if (method === 'GET' && parts.length === 3) {
        requireRole(user.id, projectId, ROLES);
        return send(res, 200, { members: q.projectMembers.all(projectId), invitations: q.invitationsOf.all(projectId) });
      }
      requireRole(user.id, projectId, ['admin']);
      if (method === 'POST' && parts.length === 3) {
        const body = await readJSON(req);
        const email = String(body.email || '').trim().toLowerCase();
        const role = String(body.role || 'miembro');
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Introduce un email válido');
        if (!ROLES.includes(role)) throw new HttpError(400, 'Rol no válido');
        const target = q.userByEmail.get(email);
        if (target) {
          if (q.role.get(projectId, target.id)) throw new HttpError(409, 'Esa persona ya tiene acceso');
          q.setMembership.run(projectId, target.id, role, Date.now());
          return send(res, 201, { status: 'added' });
        }
        q.setInvitation.run(projectId, email, role, user.id, Date.now());
        return send(res, 201, { status: 'invited' });
      }
      if (parts[3] === 'invitations' && parts[4] && method === 'DELETE') {
        q.deleteInvitation.run(projectId, decodeURIComponent(parts[4]).toLowerCase());
        return send(res, 200, { ok: true });
      }
      const targetId = parts[3];
      if (targetId && parts.length === 4) {
        const current = q.role.get(projectId, targetId);
        if (!current) throw new HttpError(404, 'Esa persona no tiene acceso');
        const lastAdmin = current.role === 'admin' && q.adminCount.get(projectId).n <= 1;
        if (method === 'PATCH') {
          const { role } = await readJSON(req);
          if (!ROLES.includes(role)) throw new HttpError(400, 'Rol no válido');
          if (lastAdmin && role !== 'admin') throw new HttpError(400, 'El proyecto necesita al menos un administrador');
          q.setMembership.run(projectId, targetId, role, Date.now());
          return send(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          if (lastAdmin) throw new HttpError(400, 'El proyecto necesita al menos un administrador');
          q.deleteMembership.run(projectId, targetId);
          return send(res, 200, { ok: true });
        }
      }
    }

    throw new HttpError(404, 'Ruta no encontrada');
  }

  // ---------- Archivos estáticos de la app ----------
  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const top = rel.split('/')[0];
    if (!PUBLIC_ENTRIES.has(top)) rel = 'index.html';
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(full).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else throw new HttpError(405, 'Método no permitido');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log(`error: ${err.stack || err}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Error interno del servidor' : err.message });
      else res.end();
    }
  });

  const cleanup = setInterval(() => q.deleteOldSessions.run(Date.now() - SESSION_TTL), 3600000);
  cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    store.close();
  });
  return server;
}
