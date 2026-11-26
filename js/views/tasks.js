import { db, STATUSES, statusOf, isOverdue, saveTask, deleteFile, fileUrl } from '../db.js';
import { esc, avatar, fmtDate, download, toast, confirmDialog, userName } from '../ui.js';
import { openTaskDrawer, newTaskForm } from './taskDetail.js';
import { canEdit } from '../sync.js';

// Los filtros se mantienen mientras la sesión esté abierta.
const filters = { q: '', status: 'open', category: '', assignee: '', sheet: '', overdue: false, sort: 'number', mode: 'list', expanded: false };
const selected = new Set();

/** Número de filtros distintos de los valores por defecto (para el botón «Filtros» en el móvil). */
function activeFilters() {
  return ['category', 'assignee', 'sheet'].filter((k) => filters[k]).length + (filters.status !== 'open' ? 1 : 0) + (filters.overdue ? 1 : 0) + (filters.sort !== 'number' ? 1 : 0);
}

function applyFilters(ctx) {
  const q = filters.q.toLowerCase();
  let list = ctx.tasks.filter((t) => {
    if (filters.status === 'open' && !statusOf(t.status).open) return false;
    if (filters.status === 'closed' && statusOf(t.status).open) return false;
    if (!['all', 'open', 'closed'].includes(filters.status) && t.status !== filters.status) return false;
    if (filters.category && t.category !== filters.category) return false;
    if (filters.assignee === '_none' && ctx.member(t.assigneeId)) return false;
    if (filters.assignee && filters.assignee !== '_none' && t.assigneeId !== filters.assignee) return false;
    if (filters.sheet === '_none' && t.sheetId) return false;
    if (filters.sheet && filters.sheet !== '_none' && t.sheetId !== filters.sheet) return false;
    if (filters.overdue && !isOverdue(t)) return false;
    if (q) {
      const hay = `#${t.number} ${t.title} ${t.description} ${t.location} ${t.tags.join(' ')} ${ctx.member(t.assigneeId)?.name || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const order = Object.fromEntries(STATUSES.map((s, i) => [s.id, i]));
  const sorters = {
    number: (a, b) => b.number - a.number,
    due: (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'),
    status: (a, b) => order[a.status] - order[b.status] || b.number - a.number,
    updated: (a, b) => b.updatedAt - a.updatedAt,
  };
  return list.sort(sorters[filters.sort]);
}

export function renderTasks(view, ctx) {
  ctx.onTaskChanged = null;
  const list = applyFilters(ctx);
  for (const id of [...selected]) if (!ctx.tasks.some((t) => t.id === id)) selected.delete(id);
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Tareas</h1><p class="muted">${list.length} de ${ctx.tasks.length} tareas</p></div>
      <div class="actions">
        <div class="seg-toggle" role="group" aria-label="Vista">
          <button class="${filters.mode === 'list' ? 'active' : ''}" data-mode="list">Lista</button>
          <button class="${filters.mode === 'board' ? 'active' : ''}" data-mode="board">Tablero</button>
        </div>
        <button class="btn" id="csv">Exportar CSV</button>
        <button class="btn" id="report">Informe</button>
        <button class="btn btn-primary write" id="new">+ Nueva tarea</button>
      </div>
    </div>

    <div class="filters ${filters.expanded ? 'expanded' : ''}">
      <input type="search" class="search" id="f-q" placeholder="Buscar por texto, #número, ubicación..." value="${esc(filters.q)}" />
      <button type="button" class="btn filters-more-btn" id="f-more" aria-expanded="${filters.expanded}">Filtros${activeFilters() ? ` · ${activeFilters()}` : ''}</button>
      <select id="f-status" aria-label="Estado">
        ${opt('open', 'Abiertas', filters.status)}${opt('closed', 'Cerradas', filters.status)}${opt('all', 'Todos los estados', filters.status)}
        ${STATUSES.map((s) => opt(s.id, s.label, filters.status)).join('')}
      </select>
      <select id="f-category" aria-label="Categoría">${opt('', 'Todas las categorías', filters.category)}${ctx.project.categories.map((c) => opt(c, c, filters.category)).join('')}</select>
      <select id="f-assignee" aria-label="Responsable">${opt('', 'Todos los responsables', filters.assignee)}${opt('_none', 'Sin asignar', filters.assignee)}${ctx.members.map((m) => opt(m.id, m.name, filters.assignee)).join('')}</select>
      <select id="f-sheet" aria-label="Plano">${opt('', 'Todos los planos', filters.sheet)}${opt('_none', 'Sin plano', filters.sheet)}${ctx.sheets.map((s) => opt(s.id, s.name, filters.sheet)).join('')}</select>
      <select id="f-sort" aria-label="Ordenar">${opt('number', 'Más recientes', filters.sort)}${opt('due', 'Vencimiento', filters.sort)}${opt('status', 'Estado', filters.sort)}${opt('updated', 'Última modificación', filters.sort)}</select>
      <label class="check-label"><input type="checkbox" id="f-overdue" ${filters.overdue ? 'checked' : ''} /> Sólo vencidas</label>
    </div>

    ${selected.size ? `
    <div class="bulk-bar">
      <strong>${selected.size} seleccionada(s)</strong>
      <select id="bulk-status"><option value="">Cambiar estado...</option>${STATUSES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
      <select id="bulk-assignee"><option value="">Asignar a...</option><option value="_none">Sin asignar</option>${ctx.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
      <button class="btn btn-sm btn-danger" id="bulk-delete">Eliminar</button>
      <button class="btn btn-sm" id="bulk-clear">Deseleccionar</button>
    </div>` : ''}

    ${filters.mode === 'list' ? listHTML(ctx, list) : boardHTML(ctx, list)}`;

  // Filtros
  const bind = (id, key, ev = 'change', prop = 'value') =>
    view.querySelector(id).addEventListener(ev, (e) => {
      filters[key] = e.target[prop];
      renderTasks(view, ctx);
      if (key === 'q') {
        const i = view.querySelector('#f-q');
        i.focus();
        i.setSelectionRange(i.value.length, i.value.length);
      }
    });
  bind('#f-q', 'q', 'input');
  bind('#f-status', 'status');
  bind('#f-category', 'category');
  bind('#f-assignee', 'assignee');
  bind('#f-sheet', 'sheet');
  bind('#f-sort', 'sort');
  bind('#f-overdue', 'overdue', 'change', 'checked');
  view.querySelector('#f-more').addEventListener('click', () => {
    filters.expanded = !filters.expanded;
    renderTasks(view, ctx);
  });
  view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    filters.mode = b.dataset.mode;
    renderTasks(view, ctx);
  }));

  view.querySelector('#new').addEventListener('click', () => newTaskForm(ctx));
  view.querySelector('#csv').addEventListener('click', () => exportCSV(ctx, list));
  view.querySelector('#report').addEventListener('click', () => printReport(ctx, list));

  view.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('input,button,a')) return;
      openTaskDrawer(ctx, el.dataset.open);
    })
  );

  // Selección
  view.querySelectorAll('[data-select]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.dataset.select);
      else selected.delete(cb.dataset.select);
      renderTasks(view, ctx);
    })
  );
  view.querySelector('#select-all')?.addEventListener('change', (e) => {
    list.forEach((t) => (e.target.checked ? selected.add(t.id) : selected.delete(t.id)));
    renderTasks(view, ctx);
  });
  const bulk = async (fn, text) => {
    for (const id of selected) {
      const t = ctx.tasks.find((x) => x.id === id);
      if (t) await saveTask(fn(t) || t, text(t), userName());
    }
    toast(`${selected.size} tarea(s) actualizadas`);
    selected.clear();
    ctx.rerender();
  };
  view.querySelector('#bulk-status')?.addEventListener('change', (e) => {
    const next = statusOf(e.target.value);
    bulk((t) => {
      if (statusOf(t.status).open && !next.open) t.completedAt = Date.now();
      if (next.open) t.completedAt = null;
      t._prev = statusOf(t.status).short;
      t.status = next.id;
    }, (t) => {
      const txt = `Estado: ${t._prev} → ${next.short}`;
      delete t._prev;
      return txt;
    });
  });
  view.querySelector('#bulk-assignee')?.addEventListener('change', (e) => {
    const v = e.target.value === '_none' ? '' : e.target.value;
    bulk((t) => void (t.assigneeId = v), () => `Asignada a ${ctx.member(v)?.name || 'nadie'}`);
  });
  view.querySelector('#bulk-delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar ${selected.size} tarea(s)?`))) return;
    for (const id of selected) {
      const t = ctx.tasks.find((x) => x.id === id);
      for (const pid of t?.photoIds || []) await deleteFile(pid);
      await db.del('tasks', id);
    }
    toast('Tareas eliminadas');
    selected.clear();
    ctx.rerender();
  });
  view.querySelector('#bulk-clear')?.addEventListener('click', () => {
    selected.clear();
    renderTasks(view, ctx);
  });

  // Tablero: arrastrar tarjetas entre columnas
  view.querySelectorAll('.board-card').forEach((card) =>
    card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.dataset.open))
  );
  view.querySelectorAll('.board-col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const t = ctx.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain'));
      const next = statusOf(col.dataset.status);
      if (!t || t.status === next.id) return;
      const prev = statusOf(t.status);
      t.status = next.id;
      if (prev.open && !next.open) t.completedAt = Date.now();
      if (next.open) t.completedAt = null;
      await saveTask(t, `Estado: ${prev.short} → ${next.short}`, userName());
      ctx.rerender();
    });
  });
}

function listHTML(ctx, list) {
  if (!list.length) return `<div class="empty"><div class="empty-icon">✅</div><h2>No hay tareas con estos filtros</h2></div>`;
  return `
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="col-check write"><input type="checkbox" id="select-all" aria-label="Seleccionar todas" ${list.every((t) => selected.has(t.id)) ? 'checked' : ''} /></th>
          <th>#</th><th>Tarea</th><th>Estado</th><th class="hide-sm">Categoría</th><th class="hide-sm">Plano</th><th>Vence</th><th>Resp.</th>
        </tr></thead>
        <tbody>
          ${list.map((t) => {
            const st = statusOf(t.status);
            const sheet = ctx.sheet(t.sheetId);
            const checks = t.checklist.length ? `<span class="muted small">☑ ${t.checklist.filter((c) => c.done).length}/${t.checklist.length}</span>` : '';
            return `
            <tr data-open="${t.id}" class="${selected.has(t.id) ? 'selected' : ''}">
              <td class="col-check write"><input type="checkbox" data-select="${t.id}" ${selected.has(t.id) ? 'checked' : ''} aria-label="Seleccionar #${t.number}" /></td>
              <td class="muted">${t.number}</td>
              <td>
                <div class="task-title-cell">${esc(t.title)}</div>
                <div class="task-sub">${t.location ? `<span class="muted small">📍 ${esc(t.location)}</span>` : ''} ${checks} ${t.photoIds.length ? `<span class="muted small">📷 ${t.photoIds.length}</span>` : ''} ${t.comments.length ? `<span class="muted small">💬 ${t.comments.length}</span>` : ''}</div>
              </td>
              <td><span class="status-pill" style="--c:${st.color}">${st.short}</span></td>
              <td class="hide-sm">${esc(t.category)}</td>
              <td class="hide-sm">${sheet ? `<a href="#/p/${ctx.project.id}/plans/${sheet.id}?task=${t.id}" class="link">${esc(sheet.name)}</a>` : '<span class="muted">—</span>'}</td>
              <td class="${isOverdue(t) ? 'text-danger' : ''}">${esc(fmtDate(t.dueDate)) || '<span class="muted">—</span>'}</td>
              <td>${avatar(ctx.member(t.assigneeId))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function boardHTML(ctx, list) {
  return `
    <div class="board">
      ${STATUSES.map((s) => {
        const col = list.filter((t) => t.status === s.id);
        return `
        <section class="board-col" data-status="${s.id}">
          <header style="--c:${s.color}"><span class="dot" style="background:${s.color}"></span>${s.label}<span class="muted small">${col.length}</span></header>
          ${col.map((t) => `
            <article class="board-card" draggable="${canEdit(ctx.project.id)}" data-open="${t.id}">
              <div class="row-between"><span class="muted small">#${t.number} · ${esc(t.category)}</span>${avatar(ctx.member(t.assigneeId))}</div>
              <p>${esc(t.title)}</p>
              <div class="task-sub">
                ${t.dueDate ? `<span class="small ${isOverdue(t) ? 'text-danger' : 'muted'}">📅 ${esc(fmtDate(t.dueDate))}</span>` : ''}
                ${t.sheetId ? '<span class="muted small">📐</span>' : ''}
                ${t.photoIds.length ? `<span class="muted small">📷 ${t.photoIds.length}</span>` : ''}
              </div>
            </article>`).join('') || '<p class="muted small center">Vacío</p>'}
        </section>`;
      }).join('')}
    </div>`;
}

function exportCSV(ctx, list) {
  const cols = ['Número', 'Título', 'Estado', 'Categoría', 'Responsable', 'Empresa', 'Inicio', 'Vencimiento', 'Ubicación', 'Plano', 'Descripción', 'Checklist', 'Fotos', 'Comentarios', 'Etiquetas', 'Creada', 'Actualizada'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = list.map((t) => {
    const m = ctx.member(t.assigneeId);
    return [
      t.number, t.title, statusOf(t.status).label, t.category, m?.name || '', m?.company || '',
      t.startDate, t.dueDate, t.location, ctx.sheet(t.sheetId)?.name || '', t.description,
      t.checklist.length ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : '',
      t.photoIds.length, t.comments.length, t.tags.join(', '),
      new Date(t.createdAt).toISOString(), new Date(t.updatedAt).toISOString(),
    ].map(q).join(';');
  });
  // BOM para que Excel reconozca UTF-8; separador ';' habitual en configuraciones en español.
  download(`tareas-${slug(ctx.project.name)}.csv`, '﻿' + [cols.map(q).join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  toast('CSV exportado');
}

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function printReport(ctx, list) {
  const w = window.open('', '_blank');
  if (!w) return toast('Permite las ventanas emergentes para generar el informe', 'error');
  const photos = {};
  for (const t of list) photos[t.id] = await Promise.all(t.photoIds.slice(0, 4).map(fileUrl));
  const now = new Date().toLocaleString('es');
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de tareas · ${esc(ctx.project.name)}</title>
  <style>
    body{font:13px/1.45 system-ui,sans-serif;color:#0f172a;margin:32px}
    h1{margin:0 0 4px;font-size:22px} .muted{color:#64748b}
    .task{border:1px solid #e2e8f0;border-left:5px solid var(--c);border-radius:6px;padding:10px 14px;margin:12px 0;break-inside:avoid}
    .task h3{margin:0 0 4px;font-size:15px} .meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:#475569;font-size:12px}
    .photos{display:flex;gap:6px;margin-top:8px} .photos img{width:120px;height:90px;object-fit:cover;border-radius:4px}
    ul{margin:6px 0;padding-left:18px} @media print{body{margin:12mm}}
  </style></head><body>
  <h1>Informe de tareas</h1>
  <div class="muted">${esc(ctx.project.name)}${ctx.project.address ? ' · ' + esc(ctx.project.address) : ''} · Generado ${esc(now)} · ${list.length} tarea(s)</div>
  ${list.map((t) => {
    const st = statusOf(t.status);
    const m = ctx.member(t.assigneeId);
    return `<div class="task" style="--c:${st.color}">
      <h3>#${t.number} · ${esc(t.title)}</h3>
      <div class="meta"><span><b>Estado:</b> ${st.label}</span><span><b>Categoría:</b> ${esc(t.category)}</span>
      <span><b>Responsable:</b> ${esc(m ? `${m.name}${m.company ? ' (' + m.company + ')' : ''}` : 'Sin asignar')}</span>
      ${t.dueDate ? `<span><b>Vence:</b> ${esc(fmtDate(t.dueDate))}</span>` : ''}
      ${t.location ? `<span><b>Ubicación:</b> ${esc(t.location)}</span>` : ''}
      ${ctx.sheet(t.sheetId) ? `<span><b>Plano:</b> ${esc(ctx.sheet(t.sheetId).name)}</span>` : ''}</div>
      ${t.description ? `<p>${esc(t.description)}</p>` : ''}
      ${t.checklist.length ? `<ul>${t.checklist.map((c) => `<li>${c.done ? '☑' : '☐'} ${esc(c.text)}</li>`).join('')}</ul>` : ''}
      ${photos[t.id].length ? `<div class="photos">${photos[t.id].map((u) => `<img src="${u}">`).join('')}</div>` : ''}
    </div>`;
  }).join('')}
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  w.document.close();
}
