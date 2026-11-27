import { db, uid } from '../db.js';
import { esc, toast, confirmDialog } from '../ui.js';
import { FIELD_TYPES } from '../forms.js';

const newField = () => ({ id: uid().slice(0, 8), label: 'Nuevo campo', type: 'text' });

export async function renderTemplateEditor(view, ctx, templateId) {
  ctx.onTaskChanged = null;
  const pid = ctx.project.id;
  const t = await db.get('templates', templateId);
  if (!t) {
    view.innerHTML = `<div class="empty"><h2>Plantilla no encontrada</h2><a class="btn" href="#/p/${pid}/forms">Volver</a></div>`;
    return;
  }
  const draw = () => {
    view.innerHTML = `
      <a href="#/p/${pid}/forms" class="muted small">← Partes</a>
      <div class="page-head"><div><h1>Editar plantilla</h1><p class="muted small">Los cambios se guardan solos. Los partes ya creados no cambian. <span id="tpl-state"></span></p></div></div>
      <section class="card form-section">
        <label class="field"><span>Nombre *</span><input id="tpl-name" value="${esc(t.name)}" /></label>
        <label class="field"><span>Descripción</span><input id="tpl-desc" value="${esc(t.description || '')}" placeholder="Para qué sirve esta plantilla" /></label>
      </section>
      ${t.sections.map((s, si) => `
        <section class="card form-section tpl-section">
          <div class="tpl-section-head">
            <input class="tpl-section-title" data-sec="${si}" value="${esc(s.title)}" aria-label="Título de la sección" />
            <button type="button" class="icon-btn" data-secmove="${si}" data-dir="-1" aria-label="Subir sección" ${si === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-secmove="${si}" data-dir="1" aria-label="Bajar sección" ${si === t.sections.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-secdel="${si}" aria-label="Eliminar sección">🗑</button>
          </div>
          ${s.fields.map((fd, fi) => `
            <div class="tpl-field">
              <input data-label="${si}:${fi}" value="${esc(fd.label)}" aria-label="Nombre del campo" />
              <select data-type="${si}:${fi}" aria-label="Tipo de campo">${FIELD_TYPES.map((ft) => `<option value="${ft.id}" ${ft.id === fd.type ? 'selected' : ''}>${esc(ft.n)}</option>`).join('')}</select>
              ${fd.type === 'select' ? `<input class="tpl-options" data-options="${si}:${fi}" value="${esc((fd.options || []).join(', '))}" placeholder="Opciones separadas por comas" aria-label="Opciones" />` : ''}
              <div class="tpl-field-actions">
                <label class="check-label small"><input type="checkbox" data-req="${si}:${fi}" ${fd.required ? 'checked' : ''} /> Obligatorio</label>
                <span class="spacer"></span>
                <button type="button" class="icon-btn icon-btn-sm" data-fmove="${si}:${fi}" data-dir="-1" aria-label="Subir campo" ${fi === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="icon-btn icon-btn-sm" data-fmove="${si}:${fi}" data-dir="1" aria-label="Bajar campo" ${fi === s.fields.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="icon-btn icon-btn-sm" data-fdel="${si}:${fi}" aria-label="Eliminar campo">✕</button>
              </div>
            </div>`).join('')}
          <button type="button" class="btn btn-sm" data-fadd="${si}">＋ Añadir campo</button>
        </section>`).join('')}
      <div class="form-actions">
        <button type="button" class="btn" id="tpl-addsec">＋ Añadir sección</button>
        <a class="btn btn-primary" href="#/p/${pid}/forms">Listo</a>
      </div>`;
    bind();
  };
  const at = (key) => key.split(':').map(Number);
  let timer = null;
  const save = (redraw = false) => {
    clearTimeout(timer);
    const st = view.querySelector('#tpl-state');
    if (st) st.textContent = '· Guardando...';
    timer = setTimeout(async () => {
      if (!t.name.trim()) t.name = 'Plantilla sin nombre';
      await db.put('templates', t);
      const s2 = view.querySelector('#tpl-state');
      if (s2) s2.textContent = '· Guardado';
    }, redraw ? 0 : 500);
    if (redraw) draw();
  };
  const bind = () => {
    view.querySelector('#tpl-name').oninput = (e) => { t.name = e.target.value; save(); };
    view.querySelector('#tpl-desc').oninput = (e) => { t.description = e.target.value; save(); };
    view.querySelectorAll('[data-sec]').forEach((i) => (i.oninput = () => { t.sections[i.dataset.sec].title = i.value; save(); }));
    view.querySelectorAll('[data-label]').forEach((i) => (i.oninput = () => { const [s, f] = at(i.dataset.label); t.sections[s].fields[f].label = i.value; save(); }));
    view.querySelectorAll('[data-type]').forEach((i) => (i.onchange = () => { const [s, f] = at(i.dataset.type); t.sections[s].fields[f].type = i.value; save(true); }));
    view.querySelectorAll('[data-options]').forEach((i) => (i.oninput = () => { const [s, f] = at(i.dataset.options); t.sections[s].fields[f].options = i.value.split(',').map((x) => x.trim()).filter(Boolean); save(); }));
    view.querySelectorAll('[data-req]').forEach((i) => (i.onchange = () => { const [s, f] = at(i.dataset.req); t.sections[s].fields[f].required = i.checked; save(); }));
    view.querySelectorAll('[data-fadd]').forEach((b) => (b.onclick = () => { t.sections[b.dataset.fadd].fields.push(newField()); save(true); }));
    view.querySelectorAll('[data-fdel]').forEach((b) => (b.onclick = () => { const [s, f] = at(b.dataset.fdel); t.sections[s].fields.splice(f, 1); save(true); }));
    view.querySelectorAll('[data-fmove]').forEach((b) => (b.onclick = () => {
      const [s, f] = at(b.dataset.fmove); const d = Number(b.dataset.dir); const arr = t.sections[s].fields;
      [arr[f], arr[f + d]] = [arr[f + d], arr[f]]; save(true);
    }));
    view.querySelectorAll('[data-secmove]').forEach((b) => (b.onclick = () => {
      const s = Number(b.dataset.secmove); const d = Number(b.dataset.dir);
      [t.sections[s], t.sections[s + d]] = [t.sections[s + d], t.sections[s]]; save(true);
    }));
    view.querySelectorAll('[data-secdel]').forEach((b) => (b.onclick = async () => {
      if (t.sections.length === 1) return toast('La plantilla necesita al menos una sección', 'error');
      if (!(await confirmDialog('¿Eliminar esta sección y sus campos?'))) return;
      t.sections.splice(Number(b.dataset.secdel), 1); save(true);
    }));
    view.querySelector('#tpl-addsec').onclick = () => { t.sections.push({ title: `Sección ${t.sections.length + 1}`, fields: [newField()] }); save(true); };
  };
  draw();
}
