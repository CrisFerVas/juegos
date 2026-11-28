import { db } from './db.js';
import { esc, toast, initials, trackOverlay } from './ui.js';
import { icon } from './icons.js';
import { statusOf, isOverdue } from './db.js';
import { session, initSession, onSync, logout, canEdit, roleOf, ROLE_LABELS, syncNow, acceptInvite } from './sync.js';
import { renderAuth } from './views/auth.js';
import { renderAccount } from './views/account.js';
import { renderProjects } from './views/projects.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPlans } from './views/plans.js';
import { renderViewer } from './views/viewer.js';
import { renderTasks } from './views/tasks.js';
import { renderTeam } from './views/team.js';
import { renderSettings } from './views/settings.js';
import { renderForms } from './views/forms.js';
import { renderFormDetail } from './views/formDetail.js';
import { renderTemplateEditor } from './views/templateEditor.js';
import { closeTaskDrawer, refreshTaskDrawer, openTaskDrawer } from './views/taskDetail.js';
import { start as startReminders } from './reminders.js';

const app = document.getElementById('app');

const NAV = [
  { id: 'dashboard', label: 'Panel', icon: 'dashboard' },
  { id: 'plans', label: 'Planos', icon: 'plans' },
  { id: 'tasks', label: 'Tareas', icon: 'tasks' },
  { id: 'forms', label: 'Partes e inspecciones', short: 'Partes', icon: 'forms' },
  { id: 'team', label: 'Equipo', icon: 'team' },
  { id: 'settings', label: 'Ajustes', icon: 'settings' },
];

/** Accesos directos a la lista de tareas con un filtro (menú lateral), con su número. */
function taskShortcuts(ctx) {
  const open = ctx.tasks.filter((t) => statusOf(t.status).open);
  const me = session.mode === 'server' && session.user ? ctx.members.find((m) => (m.email || '').toLowerCase() === session.user.email.toLowerCase()) : null;
  return [
    me && { id: 'mine', label: 'Mis tareas', icon: 'star', n: open.filter((t) => t.assigneeId === me.id).length, q: `assignee=${me.id}` },
    { id: 'open', label: 'Tareas abiertas', icon: 'open', n: open.length, q: 'status=open' },
    { id: 'overdue', label: 'Vencidas', icon: 'alert', n: open.filter(isOverdue).length, q: 'overdue=1' },
    { id: 'all', label: 'Todas las tareas', icon: 'grid', n: ctx.tasks.length, q: 'status=all' },
  ].filter(Boolean);
}

/** Menú lateral: fijo en pantallas grandes; en el móvil se abre con ☰ (y se cierra con Atrás). */
function openDrawer() {
  const shell = document.querySelector('.shell');
  if (!shell || shell.classList.contains('drawer-open')) return;
  shell.classList.add('drawer-open');
  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  shell.append(scrim);
  const close = () => {
    shell.classList.remove('drawer-open');
    scrim.remove();
  };
  scrim.addEventListener('click', close);
  shell.querySelector('.sidebar').addEventListener('click', (e) => e.target.closest('a[href]') && close());
  trackOverlay(scrim, close);
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Carga todos los datos de un proyecto en un contexto que comparten las vistas. */
async function loadContext(projectId) {
  const project = await db.get('projects', projectId);
  if (!project) return null;
  const [members, sheets, tasks, folders] = await Promise.all([
    db.byProject('members', projectId),
    db.byProject('sheets', projectId),
    db.byProject('tasks', projectId),
    db.byProject('folders', projectId),
  ]);
  members.sort((a, b) => a.name.localeCompare(b.name));
  sheets.sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name, 'es', { numeric: true }));
  tasks.sort((a, b) => b.number - a.number);
  const ctx = {
    project,
    members,
    sheets,
    tasks,
    folders,
    member: (id) => members.find((m) => m.id === id),
    sheet: (id) => sheets.find((s) => s.id === id),
    async reload() {
      const fresh = await loadContext(projectId);
      Object.assign(ctx, fresh, { reload: ctx.reload, rerender: ctx.rerender });
    },
    rerender: () => {},
  };
  return ctx;
}

let renderToken = 0;
let current = null; // { ctx } de la vista de proyecto actual, o { projects: true }

// ---------- Estado de sincronización ----------
function syncBadge() {
  if (session.mode !== 'server') return '';
  const s = session.status;
  const map = {
    syncing: ['sync-busy', 'Sincronizando...'],
    ok: ['sync-ok', session.pending ? `${session.pending} cambio(s) por enviar` : 'Sincronizado'],
    offline: ['sync-off', `Sin conexión${session.pending ? ` · ${session.pending} pendiente(s)` : ''}`],
    error: ['sync-error', 'Error al sincronizar'],
    idle: ['sync-busy', 'Conectando...'],
  };
  const [cls, label] = map[s] || map.idle;
  return `<button class="sync-badge ${cls}" data-sync title="Sincronizar ahora"><span class="sync-dot"></span><span>${esc(label)}</span></button>`;
}
function userMenu() {
  if (session.mode !== 'server' || !session.user) return '';
  return `
    <div class="user-menu">
      <a class="user-link" href="#/account" title="Mi cuenta · ${esc(session.user.email)}">
        <span class="avatar avatar-sm" style="background:var(--accent)">${esc(initials(session.user.name))}</span>
        <span class="user-name">${esc(session.user.name)}</span>
      </a>
      <button class="link small" data-logout>Cerrar sesión</button>
    </div>`;
}
function bindChrome() {
  document.querySelectorAll('[data-sync]').forEach((b) => (b.onclick = () => syncNow()));
  document.querySelectorAll('[data-logout]').forEach((b) => (b.onclick = () => logout()));
}
function updateBadges() {
  document.querySelectorAll('[data-sync]').forEach((b) => (b.outerHTML = syncBadge()));
  bindChrome();
}

/** Aplica cambios llegados de otros usuarios sin interrumpir a quien está escribiendo. */
let refreshTimer = null;
function refreshFromRemote() {
  clearTimeout(refreshTimer);
  const busy = document.querySelector('.modal-backdrop') || document.activeElement?.matches('input, textarea, select');
  if (busy) {
    refreshTimer = setTimeout(refreshFromRemote, 1500);
    return;
  }
  if (current?.projects) route();
  else if (current?.ctx) {
    const ctx = current.ctx;
    (ctx.onTaskChanged ? ctx.onTaskChanged() : ctx.rerender()).then?.(() => refreshTaskDrawer(ctx));
  }
}

async function route() {
  const token = ++renderToken;
  const [path, query = ''] = location.hash.split('?');
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  closeTaskDrawer();
  document.getElementById('modal-root').innerHTML = ''; // los diálogos no sobreviven a un cambio de pantalla

  if (parts[0] === 'invite' && parts[1]) return openInvite(parts[1]);

  if (parts[0] !== 'p' || !parts[1]) {
    const account = parts[0] === 'account';
    document.title = account ? 'ObraPlan · Mi cuenta' : 'ObraPlan · Proyectos';
    current = account ? null : { projects: true };
    document.body.classList.remove('readonly');
    app.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/"><img src="icons/icon.svg" alt="" /> ObraPlan</a>
        <span class="spacer"></span>
        ${syncBadge()}
        ${userMenu()}
      </header>
      <main class="page" id="view"></main>`;
    bindChrome();
    if (account) await renderAccount(document.getElementById('view'));
    else await renderProjects(document.getElementById('view'));
    return;
  }

  const [, projectId, section = 'plans', ...rest] = parts;
  const ctx = await loadContext(projectId);
  if (token !== renderToken) return;
  if (!ctx) {
    navigate('#/');
    return;
  }

  current = { ctx };
  const readonly = !canEdit(projectId);
  document.body.classList.toggle('readonly', readonly);
  const fullBleed = section === 'plans' && rest[0];
  const shortcuts = taskShortcuts(ctx);
  const sectionLabel = NAV.find((n) => n.id === section)?.label || '';
  app.innerHTML = `
    <div class="shell ${fullBleed ? 'shell-full' : ''}">
      <aside class="sidebar" aria-label="Menú del proyecto">
        <div class="sidebar-head">
          <strong title="${esc(ctx.project.name)}">${esc(ctx.project.name)}</strong>
          <a href="#/" class="icon-btn" title="Todos los proyectos" aria-label="Todos los proyectos">${icon('home')}</a>
        </div>
        <nav class="nav">
          ${NAV.map((n) => `
            <a href="#/p/${projectId}/${n.id}" class="nav-item ${section === n.id && !(n.id === 'tasks' && query) ? 'active' : ''}">
              <span class="nav-icon">${icon(n.icon)}</span><span>${n.label}</span>
            </a>`).join('')}
        </nav>
        <div class="nav-title">Tareas</div>
        <nav class="nav">
          ${shortcuts.map((t) => `
            <a href="#/p/${projectId}/tasks?${t.q}" class="nav-item ${section === 'tasks' && query === t.q ? 'active' : ''}">
              <span class="nav-icon">${icon(t.icon)}</span><span>${t.label}</span><span class="nav-count">${t.n}</span>
            </a>`).join('')}
        </nav>
        <div class="sidebar-foot">
          ${session.mode === 'server' ? `<span class="muted small">Tu rol: ${esc(ROLE_LABELS[roleOf(projectId)])}</span>` : ''}
          ${syncBadge()}
          ${userMenu()}
          <a href="#/" class="nav-item"><span class="nav-icon">${icon('back')}</span><span>Todos los proyectos</span></a>
        </div>
      </aside>
      <main class="content">
        ${fullBleed ? '' : `
        <header class="appbar">
          <button class="icon-btn" data-drawer aria-label="Abrir el menú">${icon('menu')}</button>
          <div class="appbar-title">
            <strong>${esc(sectionLabel)}</strong>
            <small title="${esc(ctx.project.name)}">${esc(ctx.project.name)}</small>
          </div>
          ${syncBadge()}
        </header>`}
        ${readonly ? '<div class="readonly-banner">Solo lectura: eres seguidor de este proyecto. Pide a un administrador que cambie tu rol si necesitas editar.</div>' : ''}
        <div id="view" class="view"></div>
      </main>
    </div>`;
  app.querySelector('[data-drawer]')?.addEventListener('click', openDrawer);

  bindChrome();
  const view = document.getElementById('view');
  const label = NAV.find((n) => n.id === section)?.label || '';
  document.title = `${label} · ${ctx.project.name} · ObraPlan`;

  const renderers = {
    dashboard: () => renderDashboard(view, ctx),
    plans: () => (rest[0] ? renderViewer(view, ctx, rest[0], new URLSearchParams(query)) : renderPlans(view, ctx, new URLSearchParams(query))),
    tasks: async () => {
      await renderTasks(view, ctx, new URLSearchParams(query));
      // Enlace directo a una tarea (p. ej. desde un aviso): #/p/:id/tasks?task=<id>
      const taskId = new URLSearchParams(query).get('task');
      if (taskId && ctx.tasks.some((t) => t.id === taskId)) openTaskDrawer(ctx, taskId);
    },
    forms: () =>
      rest[0] === 'templates' && rest[1] ? renderTemplateEditor(view, ctx, rest[1]) : rest[0] ? renderFormDetail(view, ctx, rest[0]) : renderForms(view, ctx),
    team: () => renderTeam(view, ctx),
    settings: () => renderSettings(view, ctx),
  };
  const render = renderers[section] || renderers.plans;
  ctx.rerender = async () => {
    await ctx.reload();
    await render();
  };
  await render();
}

/** Enlace de invitación (#/invite/<token>) con la sesión ya iniciada. */
async function openInvite(token) {
  if (session.mode !== 'server') {
    app.innerHTML = `
      <div class="auth"><div class="auth-card card">
        <div class="brand auth-brand"><img src="icons/icon.svg" alt="" /> ObraPlan</div>
        <p class="auth-error">Esta invitación es para el servidor de un equipo y esta copia de la app funciona sin servidor (modo local).
          Abre el enlace completo que te enviaron, con la dirección del servidor de tu empresa.</p>
        <a class="btn btn-block" href="#/">Ir a mis proyectos</a>
      </div></div>`;
    return;
  }
  app.innerHTML = '<div class="auth"><p class="muted">Uniéndote al proyecto...</p></div>';
  try {
    const r = await acceptInvite(token);
    toast(`Te has unido a «${r.projectName}»`);
    await syncNow();
    location.replace(`#/p/${r.project.id}`);
  } catch (err) {
    toast(err.status ? err.message : 'Sin conexión: no se pudo aceptar la invitación', 'error');
    location.replace('#/');
  }
}

// ---------- Arranque ----------
async function boot() {
  // Pide al navegador que no borre los datos locales (IndexedDB) cuando le falte espacio.
  navigator.storage?.persist?.().catch(() => {});
  const mode = await initSession();
  if (mode === 'login') {
    const invite = location.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)/)?.[1];
    return showLogin('', invite);
  }
  // Al abrir la app (no al recargar la pestaña) se empieza por la lista de proyectos, salvo que se abra
  // un enlace concreto (p. ej. desde un aviso de tarea, que lleva ?task=).
  try {
    if (!sessionStorage.getItem('obraplan.started')) {
      sessionStorage.setItem('obraplan.started', '1');
      if (location.hash.startsWith('#/p/') && !location.hash.includes('?')) history.replaceState(null, '', '#/');
    }
  } catch {
    /* sin sessionStorage */
  }
  onSync((type, detail) => {
    if (type === 'status') updateBadges();
    else if (type === 'remote-change') refreshFromRemote();
    else if (type === 'rejected') toast('Algunos cambios no se guardaron porque no tienes permiso. Se ha restaurado la versión del servidor.', 'error');
    else if (type === 'project-removed' && current?.ctx?.project.id === detail) {
      toast('Ya no tienes acceso a este proyecto', 'error');
      navigate('#/');
    } else if (type === 'auth-expired') showLogin('Tu sesión ha caducado. Vuelve a iniciar sesión; los cambios pendientes se enviarán después.');
  });
  window.addEventListener('hashchange', route);
  route();
  afterRecovery();
  startReminders();
}

/** Tras recuperar la contraseña con un código, recuerda cuántos quedan. */
function afterRecovery() {
  let left = null;
  try {
    left = sessionStorage.getItem('obraplan.recovered');
    sessionStorage.removeItem('obraplan.recovered');
  } catch {
    /* sin sessionStorage */
  }
  if (left === null) return;
  const n = Number(left);
  toast(left === '' ? 'Contraseña cambiada' : n > 2 ? `Contraseña cambiada. Te quedan ${n} códigos de recuperación.`
    : `Contraseña cambiada. Te quedan ${n} códigos de recuperación: crea unos nuevos en Mi cuenta.`, n > 2 || left === '' ? 'ok' : 'error');
}

function showLogin(message, invite = null) {
  closeTaskDrawer();
  document.title = 'ObraPlan · Iniciar sesión';
  renderAuth(app, {
    message,
    invite,
    onDone: (projectId) => {
      // Tras unirse con un enlace se abre ese proyecto; si no, la pantalla de inicio.
      history.replaceState(null, '', projectId ? `#/p/${projectId}` : '#/');
      try {
        sessionStorage.setItem('obraplan.started', '1'); // que el arranque no cambie la dirección
      } catch {
        /* sin sessionStorage */
      }
      location.reload();
    },
  });
}

boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // updateViaCache 'none': al buscar actualizaciones no se usa la caché del navegador (ni para sw.js ni
  // para los scripts que importa). Se vuelve a comprobar cada vez que se vuelve a la app.
  navigator.serviceWorker
    .register('sw.js', { updateViaCache: 'none' })
    .then((reg) => document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {})))
    .catch(() => {});
  // Cuando se instala una versión nueva de la app, se recarga para usarla (solo si había una versión
  // anterior controlando la página y no hay nada abierto encima: cámara, diálogos, editor, ficha...).
  const hadController = !!navigator.serviceWorker.controller;
  let reloadPending = false;
  const reloadIfIdle = () => {
    const busy = document.querySelector('#modal-root > *, .camera, .photo-editor, .drawer') || document.activeElement?.matches('input, textarea, select');
    if (busy) return setTimeout(reloadIfIdle, 3000);
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadPending) return;
    reloadPending = true;
    reloadIfIdle();
  });
}
