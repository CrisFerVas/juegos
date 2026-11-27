import { db } from './db.js';
import { esc, toast, initials } from './ui.js';
import { session, initSession, onSync, logout, canEdit, roleOf, ROLE_LABELS, syncNow } from './sync.js';
import { renderAuth } from './views/auth.js';
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
import { closeTaskDrawer, refreshTaskDrawer } from './views/taskDetail.js';

const app = document.getElementById('app');

const NAV = [
  { id: 'dashboard', label: 'Panel', icon: '▦' },
  { id: 'plans', label: 'Planos', icon: '▤' },
  { id: 'tasks', label: 'Tareas', icon: '☑' },
  { id: 'forms', label: 'Partes', icon: '📋' },
  { id: 'team', label: 'Equipo', icon: '👥' },
  { id: 'settings', label: 'Ajustes', icon: '⚙' },
];

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Carga todos los datos de un proyecto en un contexto que comparten las vistas. */
async function loadContext(projectId) {
  const project = await db.get('projects', projectId);
  if (!project) return null;
  const [members, sheets, tasks] = await Promise.all([
    db.byProject('members', projectId),
    db.byProject('sheets', projectId),
    db.byProject('tasks', projectId),
  ]);
  members.sort((a, b) => a.name.localeCompare(b.name));
  sheets.sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name, 'es', { numeric: true }));
  tasks.sort((a, b) => b.number - a.number);
  const ctx = {
    project,
    members,
    sheets,
    tasks,
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
      <span class="avatar avatar-sm" style="background:var(--accent)">${esc(initials(session.user.name))}</span>
      <span class="user-name" title="${esc(session.user.email)}">${esc(session.user.name)}</span>
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

  if (parts[0] !== 'p' || !parts[1]) {
    document.title = 'ObraPlan · Proyectos';
    current = { projects: true };
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
    await renderProjects(document.getElementById('view'));
    return;
  }

  const [, projectId, section = 'dashboard', ...rest] = parts;
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
  app.innerHTML = `
    <div class="shell ${fullBleed ? 'shell-full' : ''}">
      <aside class="sidebar">
        <a class="brand" href="#/"><img src="icons/icon.svg" alt="" /> <span>ObraPlan</span></a>
        <div class="sidebar-project">
          <a href="#/" class="muted small">← Proyectos</a>
          <strong title="${esc(ctx.project.name)}">${esc(ctx.project.name)}</strong>
          ${ctx.project.code ? `<span class="muted small">${esc(ctx.project.code)}</span>` : ''}
        </div>
        <nav class="nav">
          ${NAV.map((n) => `
            <a href="#/p/${projectId}/${n.id}" class="nav-item ${section === n.id ? 'active' : ''}">
              <span class="nav-icon" aria-hidden="true">${n.icon}</span><span>${n.label}</span>
            </a>`).join('')}
        </nav>
        <div class="sidebar-foot">
          ${session.mode === 'server' ? `<span class="muted small">Tu rol: ${esc(ROLE_LABELS[roleOf(projectId)])}</span>` : ''}
          ${syncBadge()}
          ${userMenu()}
        </div>
      </aside>
      <main class="content">
        ${readonly ? '<div class="readonly-banner">Solo lectura: eres seguidor de este proyecto. Pide a un administrador que cambie tu rol si necesitas editar.</div>' : ''}
        <div id="view" class="view"></div>
      </main>
      <nav class="bottom-nav">
        ${NAV.map((n) => `
          <a href="#/p/${projectId}/${n.id}" class="${section === n.id ? 'active' : ''}">
            <span aria-hidden="true">${n.icon}</span><small>${n.label}</small>
          </a>`).join('')}
      </nav>
    </div>`;

  bindChrome();
  const view = document.getElementById('view');
  const label = NAV.find((n) => n.id === section)?.label || '';
  document.title = `${label} · ${ctx.project.name} · ObraPlan`;

  const renderers = {
    dashboard: () => renderDashboard(view, ctx),
    plans: () => (rest[0] ? renderViewer(view, ctx, rest[0], new URLSearchParams(query)) : renderPlans(view, ctx)),
    tasks: () => renderTasks(view, ctx),
    forms: () =>
      rest[0] === 'templates' && rest[1] ? renderTemplateEditor(view, ctx, rest[1]) : rest[0] ? renderFormDetail(view, ctx, rest[0]) : renderForms(view, ctx),
    team: () => renderTeam(view, ctx),
    settings: () => renderSettings(view, ctx),
  };
  const render = renderers[section] || renderers.dashboard;
  ctx.rerender = async () => {
    await ctx.reload();
    await render();
  };
  await render();
}

// ---------- Arranque ----------
async function boot() {
  // Pide al navegador que no borre los datos locales (IndexedDB) cuando le falte espacio.
  navigator.storage?.persist?.().catch(() => {});
  const mode = await initSession();
  if (mode === 'login') return showLogin();
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
}

function showLogin(message) {
  closeTaskDrawer();
  document.title = 'ObraPlan · Iniciar sesión';
  renderAuth(app, { message, onDone: () => location.reload() });
}

boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
