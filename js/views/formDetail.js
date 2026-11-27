import { db, fileUrl, saveFile, deleteFile, createTask } from '../db.js';
import { esc, toast, confirmDialog, choosePhotos, modal, userName, fmtDateTime } from '../ui.js';
import { canEdit, isAdmin } from '../sync.js';
import { savePhotos } from '../media.js';
import { CHECK_RESULTS, checkSummary, missingRequired, printForm, KIND_LABEL } from '../forms.js';
import { captureSignature } from '../signature.js';
import { mountAnnotatedPhoto, openPhotoAnnotator, deletePhotoMarkups } from '../photoannotate.js';
import { openTaskDrawer } from './taskDetail.js';

export async function renderFormDetail(view, ctx, formId) {
  ctx.onTaskChanged = null;
  const pid = ctx.project.id;
  const form = await db.get('forms', formId);
  if (!form) {
    view.innerHTML = `<div class="empty"><h2>Parte no encontrado</h2><a class="btn" href="#/p/${pid}/forms">Volver a partes</a></div>`;
    return;
  }
  const editable = canEdit(pid) && form.status !== 'closed';
  const photoUrls = await Promise.all(form.photoIds.map(fileUrl));
  const signUrl = form.signature?.fileId ? await fileUrl(form.signature.fileId) : '';
  const s = checkSummary(form);
  const taskNum = (id) => ctx.tasks.find((t) => t.id === id)?.number;

  const fieldHTML = (fd) => {
    const v = form.values[fd.id];
    const req = fd.required ? ' <span class="req" title="Obligatorio">*</span>' : '';
    const name = `data-field="${esc(fd.id)}"`;
    switch (fd.type) {
      case 'textarea':
        return `<label class="field"><span>${esc(fd.label)}${req}</span><textarea ${name} rows="3">${esc(v || '')}</textarea></label>`;
      case 'number':
        return `<label class="field"><span>${esc(fd.label)}${req}</span><input ${name} type="number" inputmode="decimal" step="any" value="${esc(v ?? '')}" /></label>`;
      case 'date':
        return `<label class="field"><span>${esc(fd.label)}${req}</span><input ${name} type="date" value="${esc(v || '')}" /></label>`;
      case 'select':
        return `<label class="field"><span>${esc(fd.label)}${req}</span><select ${name}><option value="">—</option>${(fd.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      case 'yesno':
        return `<div class="field"><span>${esc(fd.label)}${req}</span><div class="seg-choice" role="group">
          <button type="button" data-yesno="${esc(fd.id)}" data-val="true" class="${v === true ? 'on' : ''}">Sí</button>
          <button type="button" data-yesno="${esc(fd.id)}" data-val="false" class="${v === false ? 'on' : ''}">No</button></div></div>`;
      case 'check': {
        const r = v?.result;
        const tid = v?.taskId;
        return `<div class="check-item ${r ? `is-${r}` : ''}">
          <div class="check-label">${esc(fd.label)}${req}</div>
          <div class="check-btns" role="group" aria-label="${esc(fd.label)}">
            ${CHECK_RESULTS.map((c) => `<button type="button" class="check-btn ${r === c.id ? 'on' : ''}" style="--c:${c.color}" data-check="${esc(fd.id)}" data-res="${c.id}" aria-pressed="${r === c.id}">${c.short} <span>${c.n}</span></button>`).join('')}
          </div>
          ${r === 'nc' || v?.note ? `<textarea class="check-note" data-note="${esc(fd.id)}" rows="2" placeholder="Describe el problema o la observación...">${esc(v?.note || '')}</textarea>` : ''}
          ${r === 'nc' ? (tid ? `<button type="button" class="link small" data-opentask="${esc(tid)}">Ver tarea #${taskNum(tid) ?? ''}</button>` : `<button type="button" class="btn btn-sm write-form" data-mktask="${esc(fd.id)}">＋ Crear tarea</button>`) : ''}
        </div>`;
      }
      case 'crew': {
        const rows = Array.isArray(v) && v.length ? v : [{ company: '', trade: '', workers: '', hours: '' }];
        const total = rows.reduce((n, x) => n + (Number(x.workers) || 0), 0);
        return `<div class="field"><span>${esc(fd.label)}${req}</span>
          <div class="crew">
            ${rows.map((x, i) => `
              <div class="crew-row" data-crew="${esc(fd.id)}" data-row="${i}">
                <label class="crew-cell"><small>Empresa</small><input data-k="company" placeholder="Empresa" value="${esc(x.company)}" /></label>
                <label class="crew-cell"><small>Oficio</small><input data-k="trade" placeholder="Oficio" value="${esc(x.trade)}" /></label>
                <label class="crew-cell"><small>Nº trabajadores</small><input data-k="workers" type="number" inputmode="numeric" min="0" placeholder="Nº" value="${esc(x.workers)}" /></label>
                <label class="crew-cell"><small>Horas</small><input data-k="hours" type="number" inputmode="decimal" min="0" step="any" placeholder="Horas" value="${esc(x.hours)}" /></label>
                <button type="button" class="icon-btn icon-btn-sm write-form" data-crewdel="${esc(fd.id)}" data-row="${i}" aria-label="Quitar fila">✕</button>
              </div>`).join('')}
            <div class="crew-foot"><button type="button" class="btn btn-sm write-form" data-crewadd="${esc(fd.id)}">＋ Añadir empresa</button><span class="muted small">Total: <strong>${total}</strong> trabajadores</span></div>
          </div></div>`;
      }
      default:
        return `<label class="field"><span>${esc(fd.label)}${req}</span><input ${name} value="${esc(v || '')}" /></label>`;
    }
  };

  view.innerHTML = `
    <div class="form-detail ${editable ? '' : 'form-locked'}">
      <a href="#/p/${pid}/forms" class="muted small">← Partes</a>
      <div class="page-head form-head">
        <div>
          <span class="form-kind kind-${esc(form.template.kind)}">${esc(KIND_LABEL[form.template.kind] || 'Parte')}</span>
          <h1>#${form.number} · ${esc(form.title)}</h1>
          <p class="muted small">${esc(form.author || '')} · creado ${esc(fmtDateTime(form.createdAt))} <span class="save-state" id="save-state"></span></p>
        </div>
        <span class="pill ${form.status === 'closed' ? 'pill-closed' : 'pill-draft'}">${form.status === 'closed' ? 'Cerrado' : 'Borrador'}</span>
      </div>
      ${form.status === 'closed' ? `<div class="readonly-banner form-banner">Parte cerrado${form.closedAt ? ` el ${esc(fmtDateTime(form.closedAt))}` : ''}. ${canEdit(pid) ? 'Para modificarlo, reábrelo.' : ''}</div>` : ''}
      <fieldset class="plain" ${editable ? '' : 'disabled'}>
        <section class="card form-section">
          <div class="row2">
            <label class="field"><span>Título</span><input data-meta="title" value="${esc(form.title)}" /></label>
            <label class="field"><span>Fecha</span><input data-meta="date" type="date" value="${esc(form.date)}" /></label>
          </div>
          ${s.total ? `<div class="check-summary"><span class="ok">✓ ${s.ok} conformes</span><span class="nc">✗ ${s.nc} no conformes</span><span>${s.na} no aplica</span>${s.pending ? `<span class="muted">${s.pending} sin revisar</span>` : ''}</div>` : ''}
        </section>
        ${form.template.sections.map((sec) => `
          <section class="card form-section">
            <h3>${esc(sec.title)}</h3>
            ${sec.fields.map(fieldHTML).join('')}
          </section>`).join('')}
        <section class="card form-section">
          <h3>Fotos <span class="muted small">${form.photoIds.length || ''}</span></h3>
          <div class="photos">
            ${photoUrls.map((u, i) => `<div class="photo"><img src="${u}" alt="Foto ${i + 1}" data-fphoto="${i}" />${editable ? `<button type="button" class="photo-del" data-fdel="${esc(form.photoIds[i])}" aria-label="Eliminar foto">✕</button>` : ''}</div>`).join('')}
            ${editable ? '<button type="button" class="photo-add" id="f-photo">＋<small>Añadir foto</small></button>' : ''}
          </div>
        </section>
      </fieldset>
      <section class="card form-section">
        <h3>Firma</h3>
        ${form.signature ? `<div class="sign-view"><img src="${signUrl}" alt="Firma" /><div><strong>${esc(form.signature.name)}</strong><br><span class="muted small">${esc(fmtDateTime(form.signature.at))}</span></div></div>` : '<p class="muted small">Sin firmar.</p>'}
        ${editable ? `<button type="button" class="btn" id="f-sign">✍ ${form.signature ? 'Volver a firmar' : 'Firmar'}</button>` : ''}
      </section>
      <div class="form-actions">
        <button type="button" class="btn" id="f-print">🖨 Imprimir / PDF</button>
        ${canEdit(pid) && form.status !== 'closed' ? '<button type="button" class="btn btn-primary" id="f-close">Cerrar parte</button>' : ''}
        ${canEdit(pid) && form.status === 'closed' ? '<button type="button" class="btn" id="f-reopen">Reabrir</button>' : ''}
        ${(form.status !== 'closed' && canEdit(pid)) || isAdmin(pid) ? '<button type="button" class="btn btn-danger" id="f-delete">Eliminar</button>' : ''}
      </div>
    </div>`;

  // ---------- Guardado automático ----------
  const saveState = view.querySelector('#save-state');
  let pending = null;
  const save = async (rerender = false) => {
    form.updatedAt = Date.now();
    await db.put('forms', form);
    saveState.textContent = '· Guardado';
    if (rerender) renderFormDetail(view, ctx, formId);
  };
  const saveSoon = () => {
    saveState.textContent = '· Guardando...';
    clearTimeout(pending);
    pending = setTimeout(save, 600);
  };

  view.querySelectorAll('[data-meta]').forEach((el) => el.addEventListener('input', () => { form[el.dataset.meta] = el.value; saveSoon(); }));
  view.querySelectorAll('[data-field]').forEach((el) =>
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input', () => {
      form.values[el.dataset.field] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
      saveSoon();
    })
  );
  view.querySelectorAll('[data-yesno]').forEach((b) =>
    (b.onclick = () => {
      const val = b.dataset.val === 'true';
      form.values[b.dataset.yesno] = form.values[b.dataset.yesno] === val ? null : val;
      save(true);
    })
  );
  view.querySelectorAll('[data-check]').forEach((b) =>
    (b.onclick = () => {
      const id = b.dataset.check;
      const cur = form.values[id] || {};
      form.values[id] = { ...cur, result: cur.result === b.dataset.res ? null : b.dataset.res };
      save(true);
    })
  );
  view.querySelectorAll('[data-note]').forEach((t) =>
    t.addEventListener('input', () => {
      form.values[t.dataset.note] = { ...(form.values[t.dataset.note] || {}), note: t.value };
      saveSoon();
    })
  );
  // Tabla de personal
  const crewRows = (id) => (Array.isArray(form.values[id]) && form.values[id].length ? form.values[id] : [{ company: '', trade: '', workers: '', hours: '' }]);
  view.querySelectorAll('.crew-row input').forEach((inp) =>
    inp.addEventListener('input', () => {
      const row = inp.closest('.crew-row');
      const rows = crewRows(row.dataset.crew);
      rows[Number(row.dataset.row)][inp.dataset.k] = inp.value;
      form.values[row.dataset.crew] = rows;
      const total = rows.reduce((n, x) => n + (Number(x.workers) || 0), 0);
      row.closest('.crew').querySelector('.crew-foot strong').textContent = total;
      saveSoon();
    })
  );
  view.querySelectorAll('[data-crewadd]').forEach((b) =>
    (b.onclick = () => {
      form.values[b.dataset.crewadd] = [...crewRows(b.dataset.crewadd), { company: '', trade: '', workers: '', hours: '' }];
      save(true);
    })
  );
  view.querySelectorAll('[data-crewdel]').forEach((b) =>
    (b.onclick = () => {
      const rows = crewRows(b.dataset.crewdel);
      rows.splice(Number(b.dataset.row), 1);
      form.values[b.dataset.crewdel] = rows;
      save(true);
    })
  );

  // ---------- No conformidad → tarea ----------
  view.querySelectorAll('[data-mktask]').forEach((b) =>
    (b.onclick = async () => {
      const id = b.dataset.mktask;
      const fd = form.template.sections.flatMap((x) => x.fields).find((x) => x.id === id);
      const v = form.values[id] || {};
      // Zona: el primer campo de texto corto del parte (p. ej. «Zona / unidad inspeccionada»)
      const zoneField = form.template.sections.flatMap((x) => x.fields).find((x) => x.type === 'text');
      const zone = (zoneField && form.values[zoneField.id]) || '';
      const task = await createTask(ctx.project, {
        title: `No conformidad: ${fd.label}`,
        status: 'p1',
        description: `${v.note || ''}\n\nDetectado en ${form.title} nº ${form.number} (${form.date})${zone ? ` · ${zone}` : ''}.`.trim(),
      }, userName());
      form.values[id] = { ...v, taskId: task.id };
      form.linkedTaskIds = [...new Set([...(form.linkedTaskIds || []), task.id])];
      await save();
      toast(`Tarea #${task.number} creada`);
      await ctx.reload();
      renderFormDetail(view, ctx, formId);
      openTaskDrawer(ctx, task.id);
    })
  );
  view.querySelectorAll('[data-opentask]').forEach((b) => (b.onclick = () => openTaskDrawer(ctx, b.dataset.opentask)));

  // ---------- Fotos ----------
  view.querySelector('#f-photo')?.addEventListener('click', async () => {
    const files = await choosePhotos({ title: `Fotos del parte nº ${form.number}` });
    if (!files.length) return;
    const ids = await savePhotos(pid, files);
    if (!ids.length) return toast('No se pudo leer ninguna foto', 'error');
    form.photoIds.push(...ids);
    await save(true);
    toast(`${ids.length} foto(s) añadida(s)`);
  });
  view.querySelectorAll('[data-fphoto]').forEach((img) =>
    (img.onclick = () => {
      const fileId = form.photoIds[Number(img.dataset.fphoto)];
      const show = () => {
        const { el, close } = modal({
          title: `Foto ${Number(img.dataset.fphoto) + 1} · Parte nº ${form.number}`,
          full: true,
          body: `<div class="pv"><div class="pv-stage"><div class="pv-photo" id="fp-photo"></div></div>
            ${editable ? '<div class="pv-info"><div class="pv-actions"><button type="button" class="btn btn-primary" id="fp-annotate">✎ Anotar foto</button></div></div>' : ''}</div>`,
        });
        mountAnnotatedPhoto(el.querySelector('#fp-photo'), ctx, fileId);
        el.querySelector('#fp-annotate')?.addEventListener('click', async () => {
          await openPhotoAnnotator(ctx, fileId);
          close();
          show();
        });
      };
      show();
    })
  );
  view.querySelectorAll('[data-fdel]').forEach((b) =>
    (b.onclick = async () => {
      if (!(await confirmDialog('¿Eliminar esta foto del parte?'))) return;
      form.photoIds = form.photoIds.filter((x) => x !== b.dataset.fdel);
      await deleteFile(b.dataset.fdel);
      await deletePhotoMarkups(pid, b.dataset.fdel);
      await save(true);
    })
  );

  // ---------- Firma, cierre, impresión ----------
  view.querySelector('#f-sign')?.addEventListener('click', async () => {
    const sig = await captureSignature({ defaultName: form.signature?.name || userName() });
    if (!sig) return;
    if (form.signature?.fileId) await deleteFile(form.signature.fileId);
    form.signature = { fileId: await saveFile(pid, sig.blob, 'firma.png'), name: sig.name, at: Date.now() };
    await save(true);
    toast('Firma guardada');
  });
  view.querySelector('#f-close')?.addEventListener('click', async () => {
    const missing = missingRequired(form);
    if (missing.length) return toast(`Faltan campos obligatorios: ${missing.join(', ')}`, 'error');
    if (!form.signature && !(await confirmDialog('El parte no está firmado. ¿Cerrarlo igualmente?', { okLabel: 'Cerrar sin firma', danger: false }))) return;
    form.status = 'closed';
    form.closedAt = Date.now();
    await save(true);
    toast('Parte cerrado');
  });
  view.querySelector('#f-reopen')?.addEventListener('click', async () => {
    form.status = 'draft';
    form.closedAt = null;
    await save(true);
    toast('Parte reabierto');
  });
  view.querySelector('#f-print').addEventListener('click', async () => {
    const ok = await printForm(form, ctx.project, ctx.members);
    if (!ok) toast('Permite las ventanas emergentes para imprimir el parte', 'error');
  });
  view.querySelector('#f-delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar el parte nº ${form.number}? No se puede deshacer.`))) return;
    for (const id of form.photoIds) {
      await deleteFile(id);
      await deletePhotoMarkups(pid, id);
    }
    if (form.signature?.fileId) await deleteFile(form.signature.fileId);
    await db.del('forms', form.id);
    toast('Parte eliminado');
    location.hash = `#/p/${pid}/forms`;
  });
}
