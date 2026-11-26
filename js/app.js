import { db } from './db.js';
import { esc } from './ui.js';
import { renderProjects } from './views/projects.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPlans } from './views/plans.js';
import { renderViewer } from './views/viewer.js';
import { renderTasks } from './views/tasks.js';
import { renderTeam } from './views/team.js';
import { renderSettings } from './views/settings.js';
import { closeTaskDrawer } from './views/taskDetail.js';

const app = document.getElementById('app');

const NAV = [
  { id: 'dashboard', label: 'Panel', icon: '▦' },
  { id: 'plans', label: 'Planos', icon: '▤' },
  { id: 'tasks', label: 'Tareas', icon: '☑' },
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

async function route() {
  const token = ++renderToken;
  const [path, query = ''] = location.hash.split('?');
  const parts = path.replace(/^#\/?/, '').split('/').filter(Boolean);
  closeTaskDrawer();

  if (parts[0] !== 'p' || !parts[1]) {
    document.title = 'ObraPlan · Proyectos';
    app.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/"><img src="icons/icon.svg" alt="" /> ObraPlan</a>
      </header>
      <main class="page" id="view"></main>`;
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
      </aside>
      <main class="content" id="view"></main>
      <nav class="bottom-nav">
        ${NAV.map((n) => `
          <a href="#/p/${projectId}/${n.id}" class="${section === n.id ? 'active' : ''}">
            <span aria-hidden="true">${n.icon}</span><small>${n.label}</small>
          </a>`).join('')}
      </nav>
    </div>`;

  const view = document.getElementById('view');
  const label = NAV.find((n) => n.id === section)?.label || '';
  document.title = `${label} · ${ctx.project.name} · ObraPlan`;

  const renderers = {
    dashboard: () => renderDashboard(view, ctx),
    plans: () => (rest[0] ? renderViewer(view, ctx, rest[0], new URLSearchParams(query)) : renderPlans(view, ctx)),
    tasks: () => renderTasks(view, ctx),
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

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
