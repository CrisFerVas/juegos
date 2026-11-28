import { db, uid } from '../db.js';
import { esc, modal, toast, confirmDialog, fmtDate } from '../ui.js';
import { listTemplates, createForm, checkSummary, KIND_LABEL } from '../forms.js';

const state = { tab: 'forms', q: '', template: '', status: '' };

export async function renderForms(view, ctx) {
  ctx.onTaskChanged = null;
  const pid = ctx.project.id;
  const [forms, templates] = await Promise.all([db.byProject('forms', pid), listTemplates(pid)]);
  forms.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.number - a.number);
  const q = state.q.toLowerCase();
  const list = forms.filter(
    (f) =>
      (!state.template || f.templateId === state.template) &&
      (!state.status || f.status === state.status) &&
      (!q || `#${f.number} ${f.title} ${f.author} ${JSON.stringify(f.values)}`.toLowerCase().includes(q))
  );
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;

  view.innerHTML = `
    <div class="page-head">
      <div><h1 class="sec-title">Partes e inspecciones</h1><p class="muted">${forms.length} parte(s) · ${templates.length} plantilla(s)</p></div>
      <div class="actions">
        <div class="seg-toggle" role="group" aria-label="Vista">
          <button class="${state.tab === 'forms' ? 'active' : ''}" data-tab="forms">Partes</button>
          <button class="${state.tab === 'templates' ? 'active' : ''}" data-tab="templates">Plantillas</button>
        </div>
        <button class="btn btn-primary write" id="new-form">+ Nuevo parte</button>
      </div>
    </div>
    ${state.tab === 'forms' ? `
      <div class="filters">
        <input type="search" class="search" id="fq" placeholder="Buscar en los partes..." value="${esc(state.q)}" />
        <select id="ft" aria-label="Plantilla">${opt('', 'Todas las plantillas', state.template)}${templates.map((t) => opt(t.id, t.name, state.template)).join('')}</select>
        <select id="fs" aria-label="Estado">${opt('', 'Todos los estados', state.status)}${opt('draft', 'Borradores', state.status)}${opt('closed', 'Cerrados', state.status)}</select>
      </div>
      ${list.length ? `<div class="form-list">${list.map((f) => formCard(f, pid)).join('')}</div>` : `
        <div class="empty"><div class="empty-icon">📋</div><h2>${forms.length ? 'Ningún parte con estos filtros' : 'Aún no hay partes'}</h2>
        <p class="muted">Crea un parte diario, una inspección de calidad o un checklist de seguridad.</p></div>`}`
    : `
      <div class="template-list">
        ${templates.map((t) => `
          <article class="card template-card">
            <div>
              <h3>${esc(t.name)} ${t.builtin ? '<span class="pill">Incluida</span>' : `<span class="pill">${esc(KIND_LABEL[t.kind] || 'Personalizada')}</span>`}</h3>
              <p class="muted small">${esc(t.description || '')} ${t.sections.reduce((n, s) => n + s.fields.length, 0)} campos en ${t.sections.length} secciones.</p>
            </div>
            <div class="actions">
              <button class="btn btn-sm btn-primary write" data-use="${t.id}">Usar</button>
              <button class="btn btn-sm write" data-dup="${t.id}">Duplicar</button>
              ${t.builtin ? '' : `<a class="btn btn-sm write" href="#/p/${pid}/forms/templates/${t.id}">Editar</a>
                <button class="icon-btn write" data-deltpl="${t.id}" aria-label="Eliminar plantilla" title="Eliminar plantilla">🗑</button>`}
            </div>
          </article>`).join('')}
        <button class="btn write" id="new-template">+ Nueva plantilla en blanco</button>
      </div>`}`;

  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderForms(view, ctx); }));
  const refocus = (id) => { const i = view.querySelector(id); i?.focus(); i?.setSelectionRange?.(i.value.length, i.value.length); };
  view.querySelector('#fq')?.addEventListener('input', (e) => { state.q = e.target.value; renderForms(view, ctx).then(() => refocus('#fq')); });
  view.querySelector('#ft')?.addEventListener('change', (e) => { state.template = e.target.value; renderForms(view, ctx); });
  view.querySelector('#fs')?.addEventListener('change', (e) => { state.status = e.target.value; renderForms(view, ctx); });

  const start = async (tpl) => {
    const form = await createForm(ctx.project, tpl);
    location.hash = `#/p/${pid}/forms/${form.id}`;
  };
  view.querySelector('#new-form')?.addEventListener('click', () => {
    const { el, close } = modal({
      title: 'Nuevo parte',
      sheet: true,
      body: `<div class="photo-source">${templates.map((t) => `
        <button type="button" class="source-btn" data-tpl="${t.id}">
          <span class="tpl-icon" aria-hidden="true">${t.kind === 'daily' ? '📅' : t.kind === 'quality' ? '✅' : t.kind === 'safety' ? '⛑️' : '📝'}</span>
          <span><strong>${esc(t.name)}</strong><small>${esc(t.description || `${t.sections.length} secciones`)}</small></span>
        </button>`).join('')}</div>`,
    });
    el.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => { close(); start(templates.find((t) => t.id === b.dataset.tpl)); }));
  });
  view.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => start(templates.find((t) => t.id === b.dataset.use))));
  view.querySelectorAll('[data-dup]').forEach((b) =>
    (b.onclick = async () => {
      const t = templates.find((x) => x.id === b.dataset.dup);
      const copy = { ...structuredClone(t), id: uid(), projectId: pid, builtin: false, kind: t.kind === 'custom' ? 'custom' : t.kind, name: `${t.name} (copia)`, createdAt: Date.now() };
      await db.put('templates', copy);
      location.hash = `#/p/${pid}/forms/templates/${copy.id}`;
    })
  );
  view.querySelector('#new-template')?.addEventListener('click', async () => {
    const t = { id: uid(), projectId: pid, name: 'Nueva plantilla', kind: 'custom', description: '', sections: [{ title: 'Sección 1', fields: [{ id: uid().slice(0, 8), label: 'Nuevo campo', type: 'text' }] }], createdAt: Date.now() };
    await db.put('templates', t);
    location.hash = `#/p/${pid}/forms/templates/${t.id}`;
  });
  view.querySelectorAll('[data-deltpl]').forEach((b) =>
    (b.onclick = async () => {
      if (!(await confirmDialog('¿Eliminar esta plantilla? Los partes ya creados con ella se conservan.'))) return;
      await db.del('templates', b.dataset.deltpl);
      toast('Plantilla eliminada');
      renderForms(view, ctx);
    })
  );
}

function formCard(f, pid) {
  const s = checkSummary(f);
  const kind = f.template.kind;
  return `
    <a class="card form-card" href="#/p/${pid}/forms/${f.id}">
      <div class="form-card-top">
        <span class="form-kind kind-${esc(kind)}">${esc(KIND_LABEL[kind] || 'Parte')}</span>
        <span class="pill ${f.status === 'closed' ? 'pill-closed' : 'pill-draft'}">${f.status === 'closed' ? 'Cerrado' : 'Borrador'}</span>
      </div>
      <strong class="form-card-title">#${f.number} · ${esc(f.title)}</strong>
      <div class="form-card-meta muted small">
        <span>📅 ${esc(fmtDate(f.date))}</span><span>${esc(f.author || '')}</span>
        ${s.total ? `<span class="ok">✓ ${s.ok}</span><span class="nc">✗ ${s.nc}</span>${s.pending ? `<span>${s.pending} sin revisar</span>` : ''}` : ''}
        ${f.photoIds.length ? `<span>📷 ${f.photoIds.length}</span>` : ''}
        ${f.signature ? '<span>✍ Firmado</span>' : ''}
      </div>
    </a>`;
}

