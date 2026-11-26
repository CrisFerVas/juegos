import { db, saveFile, deleteFile, fileUrl, uid, statusOf } from '../db.js';
import { esc, modal, toast, confirmDialog, pickFiles } from '../ui.js';
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
      <p class="muted small">Cada página de un PDF se convierte en un plano independiente.</p>
      <div id="up-status" class="muted small"></div>`,
    submitLabel: 'Subir',
    onSubmit: async (v, form) => {
      const status = form.querySelector('#up-status');
      form.querySelector('[type=submit]').disabled = true;
      let count = 0;
      for (const file of files) {
        try {
          const pages = await fileToSheets(file, (i, n) => (status.textContent = `Procesando ${file.name}: página ${i} de ${n}...`));
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

function editSheet(ctx, sheet) {
  const { el, close } = modal({
    title: 'Editar plano',
    body: `
      <label class="field"><span>Nombre *</span><input name="name" required value="${esc(sheet.name)}" /></label>
      <label class="field"><span>Carpeta / disciplina</span>${folderSelect(sheet.folder)}</label>
      <div class="field"><span>Nueva versión</span>
        <button type="button" class="btn btn-sm" id="newver">Reemplazar por nueva versión (v${(sheet.version || 1) + 1})...</button>
        <small class="muted">Las tareas mantienen su posición relativa en el plano.</small>
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
      ? `¿Eliminar "${sheet.name}"? Las ${linked.length} tarea(s) vinculadas se conservarán pero sin ubicación en plano.`
      : `¿Eliminar "${sheet.name}"?`;
    if (!(await confirmDialog(msg))) return;
    for (const t of linked) {
      t.sheetId = '';
      t.x = t.y = null;
      await db.put('tasks', t);
    }
    await deleteFile(sheet.fileId);
    if (sheet.thumbId) await deleteFile(sheet.thumbId);
    await db.del('sheets', sheet.id);
    close();
    toast('Plano eliminado');
    ctx.rerender();
  });
  el.querySelector('#newver').addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'application/pdf,image/*' });
    if (!file) return;
    try {
      const [page] = await fileToSheets(file);
      const oldFile = sheet.fileId, oldThumb = sheet.thumbId;
      sheet.fileId = await saveFile(ctx.project.id, page.blob, sheet.name);
      sheet.thumbId = await saveFile(ctx.project.id, page.thumb, sheet.name + ' (miniatura)');
      sheet.width = page.width;
      sheet.height = page.height;
      sheet.version = (sheet.version || 1) + 1;
      await db.put('sheets', sheet);
      await deleteFile(oldFile);
      if (oldThumb) await deleteFile(oldThumb);
      close();
      toast(`Versión ${sheet.version} subida`);
      ctx.rerender();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
