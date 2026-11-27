import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../app.js';

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obraplan-acc-'));
  server = createApp({ dataDir, ipLimit: 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const PW = 'contraseña-segura';
const register = async (email, extra = {}) =>
  (await call('POST', '/api/register', { body: { email, name: email.split('@')[0], password: PW, ...extra } })).body;
const login = (email, password = PW, ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile') =>
  call('POST', '/api/login', { body: { email, password }, headers: { 'User-Agent': ua } });
const newProject = (token, id, name) =>
  call('POST', '/api/sync', { token, body: { changes: [{ store: 'projects', id, op: 'put', rev: Date.now(), data: { id, name } }], cursors: {} } });

test('perfil: nombre, email y contraseña', async () => {
  const a = await register('eva@obra.test');
  assert.equal((await call('PATCH', '/api/me', { token: a.token, body: { name: 'Eva López' } })).body.user.name, 'Eva López');
  assert.equal((await call('GET', '/api/me', { token: a.token })).body.user.name, 'Eva López');

  await register('otro@obra.test');
  assert.equal((await call('POST', '/api/me/email', { token: a.token, body: { email: 'eva2@obra.test', password: 'mala' } })).status, 403);
  assert.equal((await call('POST', '/api/me/email', { token: a.token, body: { email: 'otro@obra.test', password: PW } })).status, 409);
  assert.equal((await call('POST', '/api/me/email', { token: a.token, body: { email: 'Eva2@obra.test', password: PW } })).body.user.email, 'eva2@obra.test');
  assert.equal((await login('eva2@obra.test')).status, 200);

  // Cambiar la contraseña cierra las demás sesiones, no la actual
  const other = (await login('eva2@obra.test')).body.token;
  assert.equal((await call('POST', '/api/me/password', { token: a.token, body: { current: 'mala', password: 'nueva-clave-1' } })).status, 403);
  assert.equal((await call('POST', '/api/me/password', { token: a.token, body: { current: PW, password: 'corta' } })).status, 400);
  assert.equal((await call('POST', '/api/me/password', { token: a.token, body: { current: PW, password: 'nueva-clave-1' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: other })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: a.token })).status, 200);
  assert.equal((await login('eva2@obra.test', 'nueva-clave-1')).status, 200);
});

test('sesiones: lista con dispositivo y cierre remoto', async () => {
  const a = await register('sesiones@obra.test');
  const phone = (await login('sesiones@obra.test')).body.token;
  const pc = (await login('sesiones@obra.test', PW, 'Mozilla/5.0 (Windows NT 10.0) Firefox/130')).body.token;
  const list = (await call('GET', '/api/me/sessions', { token: pc })).body.sessions;
  assert.equal(list.length, 3);
  assert.ok(list.some((s) => s.device === 'Chrome · Android'));
  assert.equal(list.find((s) => s.current).device, 'Firefox · Windows');
  assert.ok(list.every((s) => !('token' in s)));
  const phoneSession = list.find((s) => s.device === 'Chrome · Android');
  assert.equal((await call('DELETE', `/api/me/sessions/${phoneSession.id}`, { token: pc })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: phone })).status, 401);
  assert.equal((await call('DELETE', '/api/me/sessions/others', { token: pc })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: a.token })).status, 401);
  assert.equal((await call('GET', '/api/me/sessions', { token: pc })).body.sessions.length, 1);
});

test('códigos de recuperación de un solo uso', async () => {
  const a = await register('rec@obra.test');
  assert.equal((await call('GET', '/api/me', { token: a.token })).body.recoveryCodesLeft, 0);
  assert.equal((await call('POST', '/api/me/recovery-codes', { token: a.token, body: { password: 'mala' } })).status, 403);
  const { codes } = (await call('POST', '/api/me/recovery-codes', { token: a.token, body: { password: PW } })).body;
  assert.equal(codes.length, 8);
  assert.match(codes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await call('POST', '/api/recover', { body: { email: 'rec@obra.test', code: 'AAAA-BBBB', password: 'otra-clave-1' } })).status, 401);
  // Se acepta en minúsculas y sin guion
  const ok = await call('POST', '/api/recover', { body: { email: 'rec@obra.test', code: codes[0].toLowerCase().replace('-', ''), password: 'otra-clave-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recoveryCodesLeft, 7);
  assert.equal((await call('GET', '/api/me', { token: a.token })).status, 401); // sesiones anteriores cerradas
  assert.equal((await call('POST', '/api/recover', { body: { email: 'rec@obra.test', code: codes[0], password: 'otra-clave-2' } })).status, 401); // ya usado
  assert.equal((await login('rec@obra.test', 'otra-clave-1')).status, 200);
});

test('código de restablecimiento del administrador del servidor', async () => {
  await register('olvido@obra.test');
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/admin.js', 'reset-password', 'olvido@obra.test'], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  const code = out.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
  const r = await call('POST', '/api/recover', { body: { email: 'olvido@obra.test', code, password: 'recuperada-1' } });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/recover', { body: { email: 'olvido@obra.test', code, password: 'recuperada-2' } })).status, 401);
});

test('bloqueo temporal tras varios intentos fallidos', async () => {
  await register('bloqueo@obra.test');
  for (let i = 0; i < 8; i++) assert.equal((await login('bloqueo@obra.test', 'mala')).status, 401);
  const locked = await login('bloqueo@obra.test');
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /intentos fallidos/);
});

test('enlaces de invitación', async () => {
  const admin = await register('jefa@obra.test');
  await newProject(admin.token, 'p-inv', 'Hospital Norte');
  const created = await call('POST', '/api/projects/p-inv/access/links', { token: admin.token, body: { role: 'seguidor' } });
  assert.equal(created.status, 201);
  const link = created.body.token;

  const info = await call('GET', `/api/invite/${link}`);
  assert.deepEqual([info.body.projectName, info.body.role], ['Hospital Norte', 'seguidor']);
  assert.equal((await call('GET', '/api/invite/no-existe-este-enlace')).status, 404);

  // Registro con el enlace → acceso directo al proyecto
  const nuevo = await register('nuevo@obra.test', { invite: link });
  assert.deepEqual(nuevo.projects, [{ id: 'p-inv', role: 'seguidor' }]);

  // Cuenta existente que acepta el enlace
  const existente = await register('existente@obra.test');
  const acc = await call('POST', `/api/invite/${link}/accept`, { token: existente.token });
  assert.equal(acc.body.project.role, 'seguidor');
  // Un enlace no baja el rol de quien ya tiene más permisos
  assert.equal((await call('POST', `/api/invite/${link}/accept`, { token: admin.token })).body.project.role, 'admin');

  const access = await call('GET', '/api/projects/p-inv/access', { token: admin.token });
  assert.equal(access.body.links[0].uses, 2);
  assert.equal((await call('GET', '/api/projects/p-inv/access', { token: nuevo.token })).body.links.length, 0); // solo admins
  assert.equal((await call('POST', '/api/projects/p-inv/access/links', { token: nuevo.token, body: {} })).status, 403);

  assert.equal((await call('DELETE', `/api/projects/p-inv/access/links/${link}`, { token: admin.token })).status, 200);
  assert.equal((await call('GET', `/api/invite/${link}`)).status, 404);
});

test('eliminar la cuenta', async () => {
  const jefe = await register('unico@obra.test');
  const ayudante = await register('ayudante@obra.test');
  await newProject(jefe.token, 'p-comp', 'Compartido');
  await newProject(jefe.token, 'p-solo', 'Solo mío');
  await call('POST', '/api/projects/p-comp/access', { token: jefe.token, body: { email: 'ayudante@obra.test', role: 'miembro' } });

  // Único administrador de un proyecto con más personas: no se puede
  const me = await call('GET', '/api/me', { token: jefe.token });
  assert.deepEqual(me.body.blockingProjects, ['Compartido']);
  const blocked = await call('DELETE', '/api/me', { token: jefe.token, body: { password: PW } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Compartido/);

  await call('PATCH', `/api/projects/p-comp/access/${ayudante.user.id}`, { token: jefe.token, body: { role: 'admin' } });
  assert.equal((await call('DELETE', '/api/me', { token: jefe.token, body: { password: 'mala' } })).status, 403);
  assert.equal((await call('DELETE', '/api/me', { token: jefe.token, body: { password: PW } })).status, 200);
  assert.equal((await login('unico@obra.test')).status, 401);
  // El proyecto compartido sigue para el resto; el que era solo suyo se elimina
  const sync = await call('POST', '/api/sync', { token: ayudante.token, body: { changes: [], cursors: {} } });
  assert.deepEqual(sync.body.projects.map((p) => p.id), ['p-comp']);
  const access = await call('GET', '/api/projects/p-comp/access', { token: ayudante.token });
  assert.deepEqual(access.body.members.map((m) => m.email), ['ayudante@obra.test']);
  // Se puede volver a registrar con el mismo email
  assert.ok((await register('unico@obra.test')).token);
});
