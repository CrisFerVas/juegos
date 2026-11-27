import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obraplan-test-'));
  server = createApp({ dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const register = async (email, name = email.split('@')[0]) =>
  (await call('POST', '/api/register', { body: { email, name, password: 'contraseña-segura' } })).body;
const sync = (token, changes = [], cursors = {}) => call('POST', '/api/sync', { token, body: { changes, cursors } });
const put = (store, id, projectId, data, rev = Date.now()) => ({ store, id, projectId, op: 'put', rev, data: { id, projectId, ...data } });

let ana, ben, pid;

test('health y estáticos', async () => {
  assert.equal((await call('GET', '/api/health')).body.app, 'obraplan');
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /js\/app\.js/);
  // No se exponen archivos del servidor ni datos
  const secret = await call('GET', '/server/app.js');
  assert.doesNotMatch(secret.body.toString(), /createApp/);
});

test('registro, login y validaciones', async () => {
  ana = await register('ana@obra.test', 'Ana');
  assert.ok(ana.token);
  assert.equal(ana.user.email, 'ana@obra.test');
  assert.equal((await call('POST', '/api/register', { body: { email: 'ANA@obra.test', name: 'x', password: '12345678' } })).status, 409);
  assert.equal((await call('POST', '/api/register', { body: { email: 'z@obra.test', name: 'x', password: 'corta' } })).status, 400);
  assert.equal((await call('POST', '/api/login', { body: { email: 'ana@obra.test', password: 'mala-clave' } })).status, 401);
  const login = await call('POST', '/api/login', { body: { email: 'Ana@Obra.test', password: 'contraseña-segura' } });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { token: login.body.token })).body.user.name, 'Ana');
});

test('crear proyecto por sincronización convierte al autor en admin', async () => {
  pid = 'proj-1';
  const r = await sync(ana.token, [
    put('projects', pid, undefined, { name: 'Obra 1', categories: ['General'] }),
    put('tasks', 't1', pid, { number: 1, title: 'Primera', comments: [], activity: [] }),
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.projects, [{ id: pid, role: 'admin' }]);
  assert.equal(r.body.changes.length, 2);
  assert.ok(r.body.cursors[pid] > 0);
  // Sin cambios nuevos desde el cursor
  const again = await sync(ana.token, [], r.body.cursors);
  assert.equal(again.body.changes.length, 0);
});

test('otro usuario no puede leer ni escribir en un proyecto ajeno', async () => {
  ben = await register('ben@obra.test', 'Ben');
  const r = await sync(ben.token, [put('tasks', 't-x', pid, { number: 9, title: 'Intruso' })], { [pid]: 0 });
  assert.equal(r.body.rejected.length, 1);
  assert.deepEqual(r.body.removed, [pid]);
  assert.equal(r.body.changes.filter((c) => c.data).length, 0);
  // Tampoco puede "reclamar" un proyecto existente
  const claim = await sync(ben.token, [put('projects', pid, undefined, { name: 'Mío' })]);
  assert.equal(claim.body.rejected.length, 1);
});

test('invitaciones y roles', async () => {
  // Invitación a email sin cuenta → se convierte en acceso al registrarse
  const inv = await call('POST', `/api/projects/${pid}/access`, { token: ana.token, body: { email: 'carla@obra.test', role: 'seguidor' } });
  assert.equal(inv.body.status, 'invited');
  const carla = await register('carla@obra.test', 'Carla');
  assert.deepEqual(carla.projects, [{ id: pid, role: 'seguidor' }]);

  // Usuario existente → acceso directo
  const add = await call('POST', `/api/projects/${pid}/access`, { token: ana.token, body: { email: 'ben@obra.test', role: 'miembro' } });
  assert.equal(add.body.status, 'added');
  const access = await call('GET', `/api/projects/${pid}/access`, { token: ben.token });
  assert.deepEqual(access.body.members.map((m) => m.role).sort(), ['admin', 'miembro', 'seguidor']);

  // Sólo el admin gestiona accesos
  assert.equal((await call('POST', `/api/projects/${pid}/access`, { token: ben.token, body: { email: 'x@obra.test' } })).status, 403);

  // Seguidor: sólo lectura (recibe los datos, sus cambios se rechazan y se le devuelve la versión del servidor)
  const r = await sync(carla.token, [put('tasks', 't1', pid, { number: 1, title: 'Cambiado por seguidora' })]);
  assert.equal(r.body.rejected[0].reason, 'sin permiso');
  assert.equal(r.body.changes.find((c) => c.id === 't1').data.title, 'Primera');

  // Miembro: puede editar tareas pero no los datos del proyecto
  const m = await sync(ben.token, [
    put('tasks', 't1', pid, { number: 1, title: 'Editada por Ben', comments: [], activity: [] }),
    put('projects', pid, undefined, { name: 'Renombrado' }),
  ]);
  assert.equal(m.body.rejected.length, 1);
  assert.equal(m.body.rejected[0].store, 'projects');
  assert.equal(m.body.changes.find((c) => c.id === 't1').data.title, 'Editada por Ben');

  // No se puede quitar al último admin
  assert.equal((await call('DELETE', `/api/projects/${pid}/access/${ana.user.id}`, { token: ana.token })).status, 400);
});

test('números de tarea duplicados se renumeran', async () => {
  const r = await sync(ben.token, [put('tasks', 't2', pid, { number: 1, title: 'Creada sin conexión' })]);
  const t2 = r.body.changes.find((c) => c.id === 't2');
  assert.equal(t2.data.number, 2);
});

test('partes: se sincronizan y los números duplicados se renumeran', async () => {
  const a = await sync(ana.token, [put('forms', 'f-1', pid, { number: 1, title: 'Parte diario', values: {} })]);
  assert.equal(a.body.changes.find((c) => c.id === 'f-1').data.number, 1);
  const b = await sync(ben.token, [put('forms', 'f-2', pid, { number: 1, title: 'Inspección', values: {} })]);
  assert.equal(b.body.changes.find((c) => c.id === 'f-2').data.number, 2);
  // Plantillas propias
  const t = await sync(ben.token, [put('templates', 'tpl-x', pid, { name: 'Mi plantilla', sections: [] })]);
  assert.equal(t.body.rejected.length, 0);
});

test('comentarios simultáneos se fusionan y gana la edición más reciente', async () => {
  const old = Date.now() - 10000;
  await sync(ana.token, [put('tasks', 't1', pid, { number: 1, title: 'Versión Ana', comments: [{ id: 'c-ana', at: 1, text: 'de Ana' }], activity: [] }, Date.now())]);
  const r = await sync(ben.token, [put('tasks', 't1', pid, { number: 1, title: 'Versión vieja de Ben', comments: [{ id: 'c-ben', at: 2, text: 'de Ben' }], activity: [] }, old)]);
  const t1 = r.body.changes.find((c) => c.id === 't1').data;
  assert.equal(t1.title, 'Versión Ana');
  assert.deepEqual(t1.comments.map((c) => c.id), ['c-ana', 'c-ben']);
});

test('archivos: subida, descarga y permisos', async () => {
  const bytes = Buffer.from('imagen-de-prueba');
  assert.equal((await call('PUT', '/api/files/f1', { token: ben.token, headers: { 'X-Project-Id': pid }, raw: bytes })).status, 200);
  await sync(ben.token, [put('files', 'f1', pid, { type: 'image/png', name: 'foto.png' })]);
  const got = await call('GET', '/api/files/f1', { token: ana.token });
  assert.equal(got.status, 200);
  assert.equal(got.body.toString(), 'imagen-de-prueba');
  const outsider = await register('dani@obra.test');
  assert.equal((await call('GET', '/api/files/f1', { token: outsider.token })).status, 404);
  assert.equal((await call('PUT', '/api/files/f2', { token: outsider.token, headers: { 'X-Project-Id': pid }, raw: bytes })).status, 404);
});

test('borrar documentos y proyecto', async () => {
  const r = await sync(ben.token, [{ store: 'tasks', id: 't2', projectId: pid, op: 'del' }]);
  assert.equal(r.body.changes.find((c) => c.id === 't2').deleted, true);
  // Un miembro no puede borrar el proyecto
  const denied = await sync(ben.token, [{ store: 'projects', id: pid, op: 'del' }]);
  assert.equal(denied.body.rejected.length, 1);
  // El admin sí; los demás pierden el acceso
  await sync(ana.token, [{ store: 'projects', id: pid, op: 'del' }]);
  const after = await sync(ben.token, [], { [pid]: 1 });
  assert.deepEqual(after.body.removed, [pid]);
  // Y nadie puede recrearlo con el mismo identificador
  const recreate = await sync(ben.token, [put('projects', pid, undefined, { name: 'Zombi' })]);
  assert.equal(recreate.body.rejected.length, 1);
});
