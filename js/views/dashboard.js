import { STATUSES, statusOf, isOverdue, todayISO } from '../db.js';
import { esc, avatar, fmtDate } from '../ui.js';
import { openTaskDrawer, newTaskForm } from './taskDetail.js';

function bars(rows, total) {
  if (!rows.length) return '<p class="muted small">Sin datos</p>';
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(r.label)}">${r.icon || ''}${esc(r.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(r.value / max) * 100}%;background:${r.color || 'var(--accent)'}"></span></span>
      <span class="bar-value">${r.value}${total ? ` <span class="muted">(${Math.round((r.value / total) * 100)}%)</span>` : ''}</span>
    </div>`).join('')}</div>`;
}

export function renderDashboard(view, ctx) {
  const { tasks, project } = ctx;
  const open = tasks.filter((t) => statusOf(t.status).open);
  const overdue = open.filter(isOverdue);
  const weekAgo = Date.now() - 7 * 86400000;
  const closedWeek = tasks.filter((t) => !statusOf(t.status).open && (t.completedAt || 0) >= weekAgo);
  const today = todayISO();
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const upcoming = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= in7).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;

  const byStatus = STATUSES.map((s) => ({ label: s.label, value: tasks.filter((t) => t.status === s.id).length, color: s.color }));
  const catCount = {};
  open.forEach((t) => (catCount[t.category] = (catCount[t.category] || 0) + 1));
  const byCat = Object.entries(catCount).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const byAssignee = [...ctx.members.map((m) => ({ label: m.name, value: open.filter((t) => t.assigneeId === m.id).length, color: m.color })),
    { label: 'Sin asignar', value: open.filter((t) => !ctx.member(t.assigneeId)).length, color: '#94a3b8' }]
    .filter((r) => r.value > 0).sort((a, b) => b.value - a.value);

  const taskRow = (t) => `
    <li class="mini-task" data-task="${t.id}">
      <span class="dot" style="background:${statusOf(t.status).color}"></span>
      <span class="mini-task-title">#${t.number} ${esc(t.title)}</span>
      <span class="muted small ${isOverdue(t) ? 'text-danger' : ''}">${esc(fmtDate(t.dueDate))}</span>
      ${avatar(ctx.member(t.assigneeId))}
    </li>`;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Panel</h1>
        <p class="muted">${esc(project.address || '')}${project.client ? ` · Cliente: ${esc(project.client)}` : ''}</p>
      </div>
      <div class="actions"><button class="btn btn-primary write" id="new-task">+ Nueva tarea</button></div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="kpi-value">${tasks.length}</span><span class="kpi-label">Tareas totales</span></div>
      <div class="kpi"><span class="kpi-value">${open.length}</span><span class="kpi-label">Abiertas</span></div>
      <div class="kpi ${overdue.length ? 'kpi-danger' : ''}"><span class="kpi-value">${overdue.length}</span><span class="kpi-label">Vencidas</span></div>
      <div class="kpi"><span class="kpi-value">${closedWeek.length}</span><span class="kpi-label">Cerradas (7 días)</span></div>
      <div class="kpi"><span class="kpi-value">${ctx.sheets.length}</span><span class="kpi-label">Planos</span></div>
    </div>

    <div class="card progress-card">
      <div class="row-between"><strong>Avance del proyecto</strong><span>${pct}% completado</span></div>
      <div class="progress"><span style="width:${pct}%"></span></div>
    </div>

    <div class="grid dash-grid">
      <section class="card"><h3>Tareas por estado</h3>${bars(byStatus, tasks.length)}</section>
      <section class="card"><h3>Abiertas por responsable</h3>${bars(byAssignee)}</section>
      <section class="card"><h3>Abiertas por categoría</h3>${bars(byCat)}</section>
      <section class="card">
        <h3>Vencidas <span class="pill pill-danger">${overdue.length}</span></h3>
        ${overdue.length ? `<ul class="mini-list">${overdue.slice(0, 8).map(taskRow).join('')}</ul>` : '<p class="muted small">¡Nada vencido! 🎉</p>'}
      </section>
      <section class="card">
        <h3>Próximos 7 días</h3>
        ${upcoming.length ? `<ul class="mini-list">${upcoming.slice(0, 8).map(taskRow).join('')}</ul>` : '<p class="muted small">Sin vencimientos próximos.</p>'}
      </section>
      <section class="card">
        <h3>Actividad reciente</h3>
        <ul class="activity">${tasks
          .flatMap((t) => t.activity.map((a) => ({ ...a, task: t })))
          .sort((a, b) => b.at - a.at)
          .slice(0, 8)
          .map((a) => `<li data-task="${a.task.id}"><span class="muted small">${new Date(a.at).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span> <strong>#${a.task.number}</strong> ${esc(a.text)}${a.by ? ` <span class="muted">· ${esc(a.by)}</span>` : ''}</li>`)
          .join('') || '<li class="muted small">Sin actividad</li>'}</ul>
      </section>
    </div>`;

  view.querySelectorAll('[data-task]').forEach((el) => el.addEventListener('click', () => openTaskDrawer(ctx, el.dataset.task)));
  view.querySelector('#new-task').addEventListener('click', () => newTaskForm(ctx));
}
