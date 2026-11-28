import { db, saveFile, deleteFile, fileUrl, uid, statusOf } from '../db.js';
import { esc, modal, toast, confirmDialog, pickFiles, userName, trackOverlay } from '../ui.js';
import { icon } from '../icons.js';
import { canEdit } from '../sync.js';
import { fileToSheets } from '../media.js';
import { openExportDialog } from '../exportplan.js';
import {
  SUGGESTED_FOLDERS, allFolders, childFolders, sheetsIn, normPath, parentOf, baseName, cleanName, isInside, prettyPath,
  folderOptions, folderPickerHTML, folderFromForm, createFolder, moveFolder, deleteFolder,
} from '../folders.js';

const ICON_FOLDER = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
const ICON_FOLDER_OPEN = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7V10H7.2a1.5 1.5 0 0 0-1.4 1L3 18.6z"/><path d="M6.6 11.5h15a.8.8 0 0 1 .8 1.1l-2.4 6.4a1.5 1.5 0 0 1-1.4 1H3.6z"/></svg>';

/** Carpetas desplegadas en la lista de planos (por proyecto, mientras dure la sesión). */
const openKey = (pid) => `obraplan.plansOpen.${pid}`;
function openSet(pid) {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(openKey(pid)) || '[]'));
  } catch {
    return new Set();
  }
}
function saveOpen(pid, set) {
  try {
    sessionStorage.setItem(openKey(pid), JSON.stringify([...set]));
  } catch {
    /* sin sessionStorage */
  }
}

export async function renderPlans(view, ctx, params = new URLSearchParams()) {
  const { tasks, project } = ctx;
  const allPaths = allFolders(ctx);
  const opened = openSet(project.id);
  // ?f=<ruta> (p. ej. al volver del visor): se despliega esa carpeta y las que la contienen
  let focus = normPath(params.get('f') || '');
  while (focus && !allPaths.includes(focus)) focus = parentOf(focus);
  if (focus && view.dataset.focused !== focus) {
    for (let p = focus; p; p = parentOf(p)) opened.add(p);
    saveOpen(project.id, opened);
  }
  for (const p of [...opened]) if (!allPaths.includes(p)) opened.delete(p);

  const q = (view.dataset.q || '').toLowerCase();
  const searching = !!q;
  // Planos visibles: los de la raíz y los de las carpetas desplegadas (con todas sus superiores desplegadas)
  const visibleFolder = (p) => { for (let x = p; x; x = parentOf(x)) if (!opened.has(x)) return false; return true; };
  const shown = searching
    ? ctx.sheets.filter((s) => s.name.toLowerCase().includes(q) || (s.folder || '').toLowerCase().includes(q))
    : ctx.sheets.filter((s) => { const f = normPath(s.folder); return !f || visibleFolder(f); });
  const thumbs = Object.fromEntries(await Promise.all(shown.map(async (s) => [s.id, await fileUrl(s.thumbId || s.fileId)])));

  const sheetCard = (s) => {
    const st = tasks.filter((t) => t.sheetId === s.id);
    const open = st.filter((t) => statusOf(t.status).open).length;
    return `
      <article class="sheet-card">
        <a href="#/p/${project.id}/plans/${s.id}" class="sheet-thumb"><img src="${thumbs[s.id]}" alt="" loading="lazy" />${open ? `<span class="sheet-badge" title="${open} tarea(s) abierta(s)">${open}</span>` : ''}</a>
        <div class="sheet-meta">
          <a href="#/p/${project.id}/plans/${s.id}" class="sheet-name">
            <strong title="${esc(s.name)}">${esc(s.name)}</strong>
            <small class="muted">${searching ? `${esc(prettyPath(normPath(s.folder)))} · ` : ''}v${s.version || 1} · ${st.length} tarea(s)</small>
          </a>
          <button class="icon-btn icon-btn-sm write" data-edit="${s.id}" aria-label="Editar plano ${esc(s.name)}">${icon('more', 18)}</button>
        </div>
      </article>`;
  };
  const sheetGrid = (list) => (list.length ? `<div class="sheet-grid">${list.map(sheetCard).join('')}</div>` : '');
  const folderCard = (p) => {
    const n = sheetsIn(ctx, p, true).length;
    const subs = childFolders(ctx, p);
    const isOpen = opened.has(p);
    const empty = !n && !subs.length;
    return `
      <section class="folder-card ${isOpen ? 'open' : ''} ${p === focus ? 'focus' : ''}" data-path="${esc(p)}">
        <div class="folder-row">
          <button class="folder-toggle" data-toggle="${esc(p)}" aria-expanded="${isOpen}">
            <span class="folder-icon">${isOpen ? ICON_FOLDER_OPEN : ICON_FOLDER}</span>
            <span class="folder-text">
              <strong title="${esc(p)}">${esc(baseName(p))}</strong>
              <small class="muted">${n} plano${n === 1 ? '' : 's'}${subs.length ? ` · ${subs.length} subcarpeta${subs.length === 1 ? '' : 's'}` : ''}</small>
            </span>
            ${empty ? '' : `<span class="folder-chev">${icon(isOpen ? 'chevronUp' : 'chevronDown')}</span>`}
          </button>
          <button class="icon-btn" data-folder="${esc(p)}" aria-label="Opciones de la carpeta ${esc(baseName(p))}">${icon('more', 20)}</button>
        </div>
        ${isOpen ? `
        <div class="folder-body">
          ${subs.map(folderCard).join('')}
          ${sheetGrid(sheetsIn(ctx, p))}
          ${empty ? '<p class="muted small folder-empty">Carpeta vacía. Usa ⋮ para subir planos aquí o crear subcarpetas.</p>' : ''}
        </div>` : ''}
      </section>`;
  };

  const rootFolders = childFolders(ctx, '');
  const rootSheets = sheetsIn(ctx, '');
  const searchFolders = searching ? allPaths.filter((p) => baseName(p).toLowerCase().includes(q)) : [];
  view.innerHTML = `
    <div class="page-head plans-head">
      <div>
        <h1 class="sec-title">Planos</h1>
        <p class="muted hide-sm">${ctx.sheets.length} plano(s) · organízalos en carpetas y subcarpetas por especialidad.</p>
      </div>
      <div class="actions">
        <label class="searchbar">${icon('search', 20)}<input type="search" id="q" placeholder="Buscar planos o carpetas" value="${esc(view.dataset.q || '')}" /></label>
        ${ctx.sheets.length ? `<button class="btn" id="export-pdf" title="Descargar planos en PDF con anotaciones">${icon('download', 18)}<span class="btn-label">Descargar PDF</span></button>` : ''}
        ${allPaths.length ? `<button class="btn" id="toggle-all" title="${opened.size ? 'Plegar todas las carpetas' : 'Desplegar todas las carpetas'}">${icon(opened.size ? 'chevronUp' : 'chevronDown', 18)}<span class="btn-label">${opened.size ? 'Plegar todo' : 'Desplegar todo'}</span></button>` : ''}
        <button class="btn write hide-sm" id="new-folder">${icon('folderPlus', 18)} Carpeta</button>
        <button class="btn btn-primary write hide-sm" id="upload">${icon('upload', 18)} Subir planos</button>
      </div>
    </div>
    ${searching ? `
      ${searchFolders.length ? `<h2 class="folder-title">Carpetas</h2><div class="folder-list">${searchFolders.map((p) => `
        <a class="folder-card folder-row folder-link" href="#/p/${project.id}/plans?f=${encodeURIComponent(p)}" data-clear-search>
          <span class="folder-icon">${ICON_FOLDER}</span>
          <span class="folder-text"><strong>${esc(baseName(p))}</strong><small class="muted">${parentOf(p) ? esc(prettyPath(parentOf(p))) + ' · ' : ''}${sheetsIn(ctx, p, true).length} plano(s)</small></span>
        </a>`).join('')}</div>` : ''}
      ${shown.length ? `<h2 class="folder-title">Planos <span class="muted small">${shown.length}</span></h2>${sheetGrid(shown)}` : ''}
      ${!shown.length && !searchFolders.length ? '<div class="empty"><p class="muted">No hay planos ni carpetas que coincidan.</p></div>' : ''}` : `
      <div class="folder-list">${rootFolders.map(folderCard).join('')}</div>
      ${rootSheets.length ? `${rootFolders.length ? '<h2 class="folder-title">Sin carpeta</h2>' : ''}${sheetGrid(rootSheets)}` : ''}
      ${!ctx.sheets.length && !allPaths.length ? `
      <div class="empty dropzone" id="drop">
        <div class="empty-icon">📐</div>
        <h2>Sube tus planos</h2>
        <p class="muted">PDF (multipágina) o imágenes (JPG, PNG). Puedes arrastrarlos aquí. También puedes crear carpetas por especialidad.</p>
        <button class="btn btn-primary write" id="upload2">Seleccionar archivos</button>
      </div>` : ''}`}
    <button class="fab write mobile-only" id="plans-fab" aria-label="Subir planos o crear carpeta">${icon('plus', 28)}</button>`;

  const rerenderKeepScroll = async () => {
    const y = window.scrollY;
    await renderPlans(view, ctx, params);
    window.scrollTo(0, y);
  };
  view.dataset.focused = focus;
  if (focus && !searching) {
    const el = view.querySelector(`.folder-card[data-path="${CSS.escape(focus)}"]`);
    if (el && !view.dataset.scrolled) {
      view.dataset.scrolled = '1';
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -70);
    }
  }

  const qInput = view.querySelector('#q');
  qInput.addEventListener('input', () => {
    view.dataset.q = qInput.value;
    renderPlans(view, ctx, params).then(() => {
      const i = view.querySelector('#q');
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
    });
  });
  view.querySelectorAll('[data-clear-search]').forEach((a) => a.addEventListener('click', () => {
    view.dataset.q = '';
    delete view.dataset.focused;
    delete view.dataset.scrolled;
  }));
  view.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.toggle;
    if (opened.has(p)) [...opened].forEach((x) => isInside(x, p) && opened.delete(x));
    else opened.add(p);
    saveOpen(project.id, opened);
    rerenderKeepScroll();
  }));
  view.querySelector('#toggle-all')?.addEventListener('click', () => {
    saveOpen(project.id, opened.size ? new Set() : new Set(allPaths));
    rerenderKeepScroll();
  });

  const doUpload = async (files, folder = '') => {
    if (!files.length) return;
    uploadDialog(ctx, files, folder);
  };
  const pickAndUpload = async (folder = '') => doUpload(await pickFiles({ accept: 'application/pdf,image/*', multiple: true }), folder);
  view.querySelector('#upload').addEventListener('click', () => pickAndUpload());
  view.querySelector('#upload2')?.addEventListener('click', () => pickAndUpload());
  view.querySelector('#new-folder').addEventListener('click', () => newFolderDialog(ctx, ''));
  view.querySelector('#plans-fab').addEventListener('click', () =>
    fabMenu([
      { icon: 'upload', label: 'Subir planos', run: () => pickAndUpload() },
      { icon: 'folderPlus', label: 'Nueva carpeta', run: () => newFolderDialog(ctx, '') },
    ])
  );

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

  view.querySelector('#export-pdf')?.addEventListener('click', () => openExportDialog(ctx, ctx.sheets, { choose: true }));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editSheet(ctx, ctx.sheet(b.dataset.edit))));
  view.querySelectorAll('[data-folder]').forEach((b) => b.addEventListener('click', () => folderActions(ctx, b.dataset.folder, pickAndUpload)));
}

/** Menú de acciones de una carpeta (⋮). */
function folderActions(ctx, path, pickAndUpload) {
  const editable = canEdit(ctx.project.id);
  const n = sheetsIn(ctx, path, true).length;
  const items = [
    editable && { icon: 'upload', label: 'Subir planos aquí', run: () => pickAndUpload(path) },
    editable && { icon: 'folderPlus', label: 'Nueva subcarpeta', run: () => newFolderDialog(ctx, path) },
    n && { icon: 'download', label: `Descargar PDF (${n} plano${n === 1 ? '' : 's'})`, run: () => openExportDialog(ctx, sheetsIn(ctx, path, true), { choose: true }) },
    editable && { icon: 'edit', label: 'Renombrar, mover o eliminar', run: () => editFolderDialog(ctx, path, '') },
  ].filter(Boolean);
  if (!items.length) return toast('No hay acciones disponibles para esta carpeta');
  const { el, close } = modal({
    title: baseName(path),
    sheet: true,
    body: `<div class="action-list">${items.map((it, i) => `<button type="button" class="action-item" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('')}</div>`,
  });
  el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
    close();
    items[Number(b.dataset.i)].run();
  }));
}

/** Menú del botón flotante (+). */
function fabMenu(items) {
  const scrim = document.createElement('div');
  scrim.className = 'fab-scrim';
  const menu = document.createElement('div');
  menu.className = 'fab-menu';
  menu.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  const close = () => {
    scrim.remove();
    menu.remove();
  };
  scrim.addEventListener('click', close);
  menu.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
    close();
    items[Number(b.dataset.i)].run();
  }));
  document.body.append(scrim, menu);
  trackOverlay(scrim, close);
}

function newFolderDialog(ctx, parent) {
  modal({
    title: parent ? `Nueva subcarpeta en ${baseName(parent)}` : 'Nueva carpeta',
    body: `
      <label class="field"><span>Nombre *</span>
        <input name="name" required list="folder-suggest-new" autocomplete="off" placeholder="${parent ? 'Ej. Ventilación, Extinción, Baja tensión' : 'Ej. Instalaciones'}" />
        <datalist id="folder-suggest-new">${SUGGESTED_FOLDERS.map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>
      </label>
      <label class="field"><span>Dentro de</span><select name="parent">${folderOptions(ctx, parent)}</select></label>`,
    submitLabel: 'Crear',
    onSubmit: async (v) => {
      const name = cleanName(v.name);
      if (!name) return false;
      const path = normPath(`${v.parent}/${name}`);
      if (allFolders(ctx).includes(path)) {
        toast('Ya existe una carpeta con ese nombre', 'error');
        return false;
      }
      await createFolder(ctx, path);
      toast(`Carpeta «${name}» creada`);
      ctx.rerender();
    },
  });
}

function editFolderDialog(ctx, path, current) {
  const n = sheetsIn(ctx, path, true).length;
  const subs = allFolders(ctx).filter((p) => p !== path && isInside(p, path)).length;
  const { el, close } = modal({
    title: 'Carpeta',
    body: `
      <label class="field"><span>Nombre *</span><input name="name" required value="${esc(baseName(path))}" /></label>
      <label class="field"><span>Dentro de</span><select name="parent">${folderOptions(ctx, parentOf(path), { exclude: path })}</select></label>
      <p class="muted small">${n} plano(s)${subs ? ` y ${subs} subcarpeta(s)` : ''}. Al renombrar o mover, todo su contenido se mueve con ella.</p>
      <hr />
      <button type="button" class="btn btn-danger btn-sm" id="del-folder">Eliminar carpeta</button>`,
    onSubmit: async (v) => {
      const name = cleanName(v.name);
      if (!name) return false;
      const to = normPath(`${v.parent}/${name}`);
      if (to === path) return;
      if (allFolders(ctx).includes(to)) {
        toast('Ya existe una carpeta con ese nombre en ese lugar', 'error');
        return false;
      }
      try {
        await moveFolder(ctx, path, to);
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
      toast('Carpeta actualizada');
      // Si se estaba dentro de la carpeta movida, se sigue en su nueva ubicación
      if (current && isInside(current, path)) location.hash = `#/p/${ctx.project.id}/plans?f=${encodeURIComponent(to + current.slice(path.length))}`;
      else ctx.rerender();
    },
  });
  el.querySelector('#del-folder').addEventListener('click', async () => {
    const parent = parentOf(path);
    const msg = n || subs
      ? `¿Eliminar la carpeta «${baseName(path)}»? Sus ${n} plano(s)${subs ? ` y ${subs} subcarpeta(s)` : ''} no se borran: pasan a «${parent ? baseName(parent) : 'Planos'}».`
      : `¿Eliminar la carpeta vacía «${baseName(path)}»?`;
    if (!(await confirmDialog(msg))) return;
    await deleteFolder(ctx, path);
    close();
    toast('Carpeta eliminada');
    if (current && isInside(current, path)) location.hash = `#/p/${ctx.project.id}/plans${parent ? `?f=${encodeURIComponent(parent)}` : ''}`;
    else ctx.rerender();
  });
}

function uploadDialog(ctx, files, current = '') {
  modal({
    title: 'Subir planos',
    body: `
      <p class="muted small">${files.map((f) => esc(f.name)).join('<br>')}</p>
      ${folderPickerHTML(ctx, current)}
      <p class="muted small">Cada página de un PDF se convierte en un plano independiente. Se conserva el archivo original para verlo con toda su calidad al hacer zoom.</p>
      <div id="up-status" class="muted small"></div>`,
    submitLabel: 'Subir',
    onSubmit: async (v, form) => {
      const status = form.querySelector('#up-status');
      form.querySelector('[type=submit]').disabled = true;
      let count = 0;
      const folder = folderFromForm(v);
      if (folder) await createFolder(ctx, folder);
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
              folder,
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
      ${folderPickerHTML(ctx, normPath(sheet.folder))}
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
      sheet.folder = folderFromForm(v);
      if (sheet.folder) await createFolder(ctx, sheet.folder);
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
