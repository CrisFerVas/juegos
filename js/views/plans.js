import { db, saveFile, deleteFile, fileUrl, uid, statusOf } from '../db.js';
import { esc, modal, toast, confirmDialog, pickFiles, userName } from '../ui.js';
import { fileToSheets } from '../media.js';

const FOLDERS = ['Arquitectura', 'Estructura', 'Instalaciones', 'Electricidad', 'Fontanería', 'Climatización', 'Urbanización', 'Otros'];

export async function renderPlans(view, ctx) {
  const { sheets, tasks, project } = ctx;
  const q = (view.dataset.q || '').toLowerCase();
  const filtered = sheets.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.folder || '').toLowerCase().includes(q));
  const groups = {};
  filtered.forEach((s) => (groups[s.folder || 'Sin carpeta'] ||= []).push(s));
  const thumbs = Object.fromEntries(await Promise.all(sheets.map(async (s) => [s.id, await fileUrl(s.thumbId || s.fileId)])));

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Planos</h1><p class="muted">${sheets.length} plano(s) · toca un plano para abrirlo y añadir tareas sobre él.</p></div>
      <div class="actions">
        <input type="search" class="search" id="q" placeholder="Buscar plano..." value="${esc(view.dataset.q || '')}" />
        <button class="btn btn-primary write" id="upload">⇪ Subir planos</button>
      </div>
    </div>
    ${sheets.length === 0 ? `
      <div class="empty dropzone" id="drop">
        <div class="empty-icon">📐</div>
        <h2>Sube tus planos</h2>
        <p class="muted">PDF (multipágina) o imágenes (JPG, PNG). Puedes arrastrarlos aquí.</p>
        <button class="btn btn-primary write" id="upload2">Seleccionar archivos</button>
      </div>` : Object.entries(groups).map(([folder, list]) => `
      <section class="folder">
        <h2 class="folder-title">📁 ${esc(folder)} <span class="muted small">${list.length}</span></h2>
        <div class="grid sheets">
          ${list.map((s) => {
            const st = tasks.filter((t) => t.sheetId === s.id);
            const open = st.filter((t) => statusOf(t.status).open).length;
            return `
            <article class="card sheet-card">
              <a href="#/p/${project.id}/plans/${s.id}" class="sheet-thumb"><img src="${thumbs[s.id]}" alt="${esc(s.name)}" loading="lazy" /></a>
              <div class="sheet-meta">
                <div>
                  <strong title="${esc(s.name)}">${esc(s.name)}</strong>
                  <p class="muted small">v${s.version || 1} · ${open} abiertas / ${st.length} tareas</p>
                </div>
                <button class="icon-btn write" data-edit="${s.id}" aria-label="Editar plano">⋯</button>
              </div>
            </article>`;
          }).join('')}
        </div>
      </section>`).join('')}`;

  const qInput = view.querySelector('#q');
  qInput.addEventListener('input', () => {
    view.dataset.q = qInput.value;
    renderPlans(view, ctx).then(() => {
      const i = view.querySelector('#q');
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
    });
  });

  const doUpload = async (files) => {
    if (!files.length) return;
    uploadDialog(ctx, files);
  };
  view.querySelector('#upload').addEventListener('click', async () => doUpload(await pickFiles({ accept: 'application/pdf,image/*', multiple: true })));
  view.querySelector('#upload2')?.addEventListener('click', async () => doUpload(await pickFiles({ accept: 'application/pdf,image/*', multiple: true })));

  // Arrastrar y soltar en toda la vista
  view.ondragover = (e) => {
    e.preventDefault();
    view.classList.add('dragging');
  };
  view.ondragleave = (e) => {
    if (e.target === view) view.classList.remove('dragging');
  };
  view.ondrop = (e) => {
    e.preventDefault();
    view.classList.remove('dragging');
    doUpload([...e.dataTransfer.files]);
  };

  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editSheet(ctx, ctx.sheet(b.dataset.edit))));
}

function folderSelect(selected) {
  return `<input name="folder" list="folders" value="${esc(selected || '')}" placeholder="Ej. Arquitectura" />
    <datalist id="folders">${FOLDERS.map((f) => `<option value="${f}"></option>`).join('')}</datalist>`;
}

function uploadDialog(ctx, files) {
  modal({
    title: 'Subir planos',
    body: `
      <p class="muted small">${files.map((f) => esc(f.name)).join('<br>')}</p>
      <label class="field"><span>Carpeta / disciplina</span>${folderSelect('Arquitectura')}</label>
      <p class="muted small">Cada página de un PDF se convierte en un plano independiente. Se conserva el archivo original para verlo con toda su calidad al hacer zoom.</p>
      <div id="up-status" class="muted small"></div>`,
    submitLabel: 'Subir',
    onSubmit: async (v, form) => {
      const status = form.querySelector('#up-status');
      form.querySelector('[type=submit]').disabled = true;
      let count = 0;
      for (const file of files) {
        try {
          const { pdf, sheets: pages } = await fileToSheets(file, (i, n) => (status.textContent = `Procesando ${file.name}: página ${i} de ${n}...`));
          status.textContent = `Guardando ${file.name}...`;
          // El PDF original se guarda una vez y lo comparten todas sus páginas.
          const pdfFileId = pdf ? await saveFile(ctx.project.id, pdf, file.name) : '';
          for (const p of pages) {
            await db.put('sheets', {
              id: uid(),
              projectId: ctx.project.id,
              name: p.name,
              folder: v.folder || 'Sin carpeta',
              version: 1,
              fileId: await saveFile(ctx.project.id, p.blob, p.name),
              thumbId: await saveFile(ctx.project.id, p.thumb, p.name + ' (miniatura)'),
              width: p.width,
              height: p.height,
              pdfFileId,
              pdfPage: p.pdfPage || null,
              pageWidthMm: p.pageWidthMm || null,
              uploadedAt: Date.now(),
              uploadedBy: userName(),
              createdAt: Date.now(),
            });
            count++;
          }
        } catch (err) {
          toast(err.message || `Error con ${file.name}`, 'error');
        }
      }
      if (count) toast(`${count} plano(s) añadido(s)`);
      ctx.rerender();
    },
  });
}

// Campos que describen el archivo de una versión del plano
const VERSION_FIELDS = ['version', 'fileId', 'thumbId', 'pdfFileId', 'pdfPage', 'pageWidthMm', 'width', 'height', 'calibration', 'uploadedAt', 'uploadedBy'];
const pickVersion = (sheet) => Object.fromEntries(VERSION_FIELDS.map((k) => [k, sheet[k] ?? null]));
const dateFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Borra los archivos de una versión (el PDF sólo si nadie más lo usa). */
async function deleteVersionFiles(ctx, v, sheetId) {
  if (v.fileId) await deleteFile(v.fileId);
  if (v.thumbId) await deleteFile(v.thumbId);
  await releasePdf(ctx, v.pdfFileId, sheetId, v);
}

function editSheet(ctx, sheet) {
  const versions = [...(sheet.versions || [])].sort((a, b) => b.version - a.version);
  const current = sheet.version || 1;
  const vLabel = (v) => `v${v.version || 1}${v.uploadedAt || v.createdAt ? ` · ${dateFmt.format(v.uploadedAt || v.createdAt)}` : ''}${v.uploadedBy ? ` · ${v.uploadedBy}` : ''}`;
  const { el, close } = modal({
    title: 'Editar plano',
    body: `
      <label class="field"><span>Nombre *</span><input name="name" required value="${esc(sheet.name)}" /></label>
      <label class="field"><span>Carpeta / disciplina</span>${folderSelect(sheet.folder)}</label>
      <div class="field"><span>Versiones</span>
        <ul class="version-list">
          <li><strong>${esc(vLabel({ ...sheet, createdAt: sheet.createdAt }))}</strong> <span class="pill">Actual</span></li>
          ${versions.map((v) => `
            <li>
              <span>${esc(vLabel(v))}</span>
              <span class="version-actions">
                <a class="btn btn-sm" href="#/p/${ctx.project.id}/plans/${sheet.id}?compare=${v.version}">Comparar</a>
                <button type="button" class="icon-btn icon-btn-sm" data-delver="${v.version}" title="Eliminar esta versión" aria-label="Eliminar versión ${v.version}">✕</button>
              </span>
            </li>`).join('')}
        </ul>
        <button type="button" class="btn btn-sm" id="newver">Subir nueva versión (v${current + 1})...</button>
        <small class="muted">La versión actual se conserva en el historial para poder compararla. Las tareas y anotaciones mantienen su posición.</small>
      </div>
      <hr />
      <button type="button" class="btn btn-danger btn-sm" id="del">Eliminar plano</button>`,
    onSubmit: async (v) => {
      sheet.name = v.name.trim();
      sheet.folder = v.folder.trim() || 'Sin carpeta';
      await db.put('sheets', sheet);
      ctx.rerender();
    },
  });
  el.querySelector('#del').addEventListener('click', async () => {
    const linked = ctx.tasks.filter((t) => t.sheetId === sheet.id);
    const msg = linked.length
      ? `¿Eliminar "${sheet.name}" y todas sus versiones? Las ${linked.length} tarea(s) vinculadas se conservarán pero sin ubicación en plano.`
      : `¿Eliminar "${sheet.name}" y todas sus versiones?`;
    if (!(await confirmDialog(msg))) return;
    for (const t of linked) {
      t.sheetId = '';
      t.x = t.y = null;
      await db.put('tasks', t);
    }
    for (const v of [pickVersion(sheet), ...versions]) await deleteVersionFiles(ctx, v, sheet.id);
    for (const m of await db.byProject('markups', ctx.project.id)) {
      if (m.sheetId !== sheet.id) continue;
      for (const id of m.photoIds || []) await deleteFile(id); // fotos colocadas en el plano
      await db.del('markups', m.id);
    }
    await db.del('sheets', sheet.id);
    close();
    toast('Plano eliminado');
    ctx.rerender();
  });
  el.querySelectorAll('[data-delver]').forEach((b) =>
    b.addEventListener('click', async () => {
      const n = Number(b.dataset.delver);
      if (!(await confirmDialog(`¿Eliminar la versión ${n} del historial? No se podrá comparar con ella.`))) return;
      const v = (sheet.versions || []).find((x) => x.version === n);
      sheet.versions = (sheet.versions || []).filter((x) => x.version !== n);
      await db.put('sheets', sheet);
      if (v) await deleteVersionFiles(ctx, v, sheet.id);
      close();
      toast(`Versión ${n} eliminada`);
      ctx.rerender();
    })
  );
  el.querySelector('#newver').addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'application/pdf,image/*' });
    if (!file) return;
    const btn = el.querySelector('#newver');
    btn.disabled = true;
    btn.textContent = 'Procesando...';
    try {
      const { pdf, sheets: [page] } = await fileToSheets(file);
      // La versión actual pasa al historial (sus archivos se conservan)
      sheet.versions = [...(sheet.versions || []), { ...pickVersion(sheet), uploadedAt: sheet.uploadedAt || sheet.createdAt }];
      sheet.fileId = await saveFile(ctx.project.id, page.blob, sheet.name);
      sheet.thumbId = await saveFile(ctx.project.id, page.thumb, sheet.name + ' (miniatura)');
      sheet.pdfFileId = pdf ? await saveFile(ctx.project.id, pdf, file.name) : '';
      sheet.pdfPage = page.pdfPage || null;
      sheet.pageWidthMm = page.pageWidthMm || null;
      sheet.width = page.width;
      sheet.height = page.height;
      sheet.version = current + 1;
      sheet.uploadedAt = Date.now();
      sheet.uploadedBy = userName();
      // Una escala de impresión (1:N) se recalcula con el tamaño del nuevo papel
      if (sheet.calibration?.method === 'scale' && sheet.pageWidthMm) {
        sheet.calibration = { ...sheet.calibration, metersPerWidth: (sheet.pageWidthMm * sheet.calibration.scale) / 1000 };
      }
      await db.put('sheets', sheet);
      close();
      toast(`Versión ${sheet.version} subida`);
      ctx.rerender();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Subir nueva versión (v${current + 1})...`;
      toast(err.message, 'error');
    }
  });
}

/** Borra el PDF original si ningún otro plano lo usa. */
async function releasePdf(ctx, pdfFileId, sheetId, exceptVersion = null) {
  if (!pdfFileId) return;
  const usedBy = (s) => s.pdfFileId === pdfFileId || (s.versions || []).some((v) => v !== exceptVersion && v.pdfFileId === pdfFileId);
  if (ctx.sheets.some((s) => (s.id !== sheetId ? usedBy(s) : (s.versions || []).some((v) => v !== exceptVersion && v.pdfFileId === pdfFileId)))) return;
  await deleteFile(pdfFileId);
}
