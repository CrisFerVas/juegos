import { db, STATUSES, statusOf, createTask, saveTask, saveFile, fileUrl, deleteFile, isOverdue, uid } from '../db.js';
import { esc, modal, toast, confirmDialog, fmtDateTime, choosePhotos, userName } from '../ui.js';
import { savePhotos } from '../media.js';
import { canEdit } from '../sync.js';

let drawer = null;

export function closeTaskDrawer() {
  drawer?.remove();
  drawer = null;
  document.body.classList.remove('drawer-open');
}

function notify(ctx, task) {
  if (ctx.onTaskChanged) ctx.onTaskChanged(task);
  else ctx.rerender();
}

const memberOptions = (ctx, selected) =>
  `<option value="">Sin asignar</option>` +
  ctx.members.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}${m.company ? ` (${esc(m.company)})` : ''}</option>`).join('');

const categoryOptions = (ctx, selected) => {
  const cats = [...ctx.project.categories];
  if (selected && !cats.includes(selected)) cats.push(selected);
  return cats.map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
};

const sheetOptions = (ctx, selected) =>
  `<option value="">Sin plano</option>` +
  ctx.sheets.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

/** Formulario rápido para crear una tarea. `preset` permite fijar plano y coordenadas. */
export function newTaskForm(ctx, preset = {}) {
  return new Promise((resolve) => {
    let created = null;
    const m = modal({
      title: preset.sheetId ? 'Nueva tarea en plano' : 'Nueva tarea',
      body: `
        <label class="field"><span>Título *</span><input name="title" required placeholder="Describe brevemente el trabajo o incidencia" /></label>
        <div class="field"><span>Prioridad / estado</span>
          <div class="segmented">${STATUSES.slice(0, 3).map((s, i) => `
            <label><input type="radio" name="status" value="${s.id}" ${i === 1 ? 'checked' : ''} /><span style="--c:${s.color}">${s.short}</span></label>`).join('')}
          </div>
        </div>
        <div class="row2">
          <label class="field"><span>Responsable</span><select name="assigneeId">${memberOptions(ctx, '')}</select></label>
          <label class="field"><span>Categoría</span><select name="category">${categoryOptions(ctx, ctx.project.categories[0])}</select></label>
        </div>
        <div class="row2">
          <label class="field"><span>Vencimiento</span><input type="date" name="dueDate" /></label>
          <label class="field"><span>Ubicación</span><input name="location" placeholder="Ej. Planta 2, baño" /></label>
        </div>
        ${preset.sheetId ? '' : `<label class="field"><span>Plano</span><select name="sheetId">${sheetOptions(ctx, '')}</select></label>`}
        <label class="field"><span>Descripción</span><textarea name="description" rows="3"></textarea></label>`,
      submitLabel: 'Crear tarea',
      onSubmit: async (v) => {
        const data = { ...v, ...preset };
        if (!preset.sheetId && v.sheetId) {
          // Sin coordenadas: se ubicará en el centro; el usuario puede moverlo luego.
          data.x = 0.5;
          data.y = 0.5;
        }
        created = await createTask(ctx.project, data, userName());
        toast(`Tarea #${created.number} creada`);
        notify(ctx, created);
        resolve(created);
        if (!preset.silent) openTaskDrawer(ctx, created.id);
      },
    });
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        if (!created) resolve(null);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

/** Vuelve a pintar el panel abierto (p. ej. tras recibir cambios de otra persona). */
export async function refreshTaskDrawer(ctx) {
  if (!drawer) return;
  const task = await db.get('tasks', drawer.dataset.task);
  if (!task) return closeTaskDrawer();
  await renderDrawer(ctx, task);
}

export async function openTaskDrawer(ctx, taskId) {
  const task = await db.get('tasks', taskId);
  if (!task) return;
  if (!drawer) {
    drawer = document.createElement('aside');
    drawer.className = 'drawer';
    document.body.appendChild(drawer);
    document.body.classList.add('drawer-open');
  }
  drawer.dataset.task = task.id;
  await renderDrawer(ctx, task);
}

async function renderDrawer(ctx, task) {
  const st = statusOf(task.status);
  const sheet = ctx.sheet(task.sheetId);
  const doneCount = task.checklist.filter((c) => c.done).length;
  const photoUrls = await Promise.all(task.photoIds.map(fileUrl));
  const sheetThumb = sheet ? await fileUrl(sheet.thumbId || sheet.fileId) : '';
  const me = userName();

  drawer.innerHTML = `
    <header class="drawer-head" style="border-top:4px solid ${st.color}">
      <span class="task-number">#${task.number}</span>
      ${isOverdue(task) ? '<span class="pill pill-danger">Vencida</span>' : ''}
      <span class="spacer"></span>
      <button class="icon-btn write" data-act="delete" title="Eliminar tarea" aria-label="Eliminar tarea">🗑</button>
      <button class="icon-btn" data-act="close" title="Cerrar" aria-label="Cerrar">✕</button>
    </header>
    <div class="drawer-body">
      <fieldset class="plain" ${canEdit(ctx.project.id) ? '' : 'disabled'}>
      <textarea class="title-input" data-field="title" rows="2">${esc(task.title)}</textarea>

      <div class="status-picker">
        ${STATUSES.map((s) => `<button class="status-btn ${s.id === task.status ? 'active' : ''}" data-status="${s.id}" style="--c:${s.color}">${s.short}</button>`).join('')}
      </div>

      <div class="field-grid">
        <label class="field"><span>Responsable</span><select data-field="assigneeId">${memberOptions(ctx, task.assigneeId)}</select></label>
        <label class="field"><span>Categoría</span><select data-field="category">${categoryOptions(ctx, task.category)}</select></label>
        <label class="field"><span>Inicio</span><input type="date" data-field="startDate" value="${esc(task.startDate)}" /></label>
        <label class="field"><span>Vencimiento</span><input type="date" data-field="dueDate" value="${esc(task.dueDate)}" /></label>
        <label class="field"><span>Ubicación</span><input data-field="location" value="${esc(task.location)}" /></label>
        <label class="field"><span>Etiquetas</span><input data-field="tags" value="${esc(task.tags.join(', '))}" placeholder="separadas por comas" /></label>
      </div>

      <section class="drawer-section">
        <h4>Plano</h4>
        ${sheet ? `
          <div class="plan-ref">
            <div class="plan-ref-thumb">
              <img src="${sheetThumb}" alt="" />
              ${task.x != null ? `<span class="pin pin-static" style="left:${task.x * 100}%;top:${task.y * 100}%;--c:${st.color}">${task.number}</span>` : ''}
            </div>
            <div>
              <strong>${esc(sheet.name)}</strong>
              <div class="actions">
                <a class="btn btn-sm" href="#/p/${ctx.project.id}/plans/${sheet.id}?task=${task.id}">Ver en plano</a>
                <a class="btn btn-sm write" href="#/p/${ctx.project.id}/plans/${sheet.id}?place=${task.id}">Reubicar</a>
                <button class="btn btn-sm" data-act="unpin">Quitar</button>
              </div>
            </div>
          </div>` : `
          <div class="row-gap">
            <select id="place-sheet">${sheetOptions(ctx, '')}</select>
            <button class="btn btn-sm" data-act="place">Ubicar en plano</button>
          </div>`}
      </section>

      <section class="drawer-section">
        <h4>Descripción</h4>
        <textarea data-field="description" rows="3" placeholder="Añade detalles...">${esc(task.description)}</textarea>
      </section>

      <section class="drawer-section">
        <h4>Lista de verificación ${task.checklist.length ? `<span class="muted small">${doneCount}/${task.checklist.length}</span>` : ''}</h4>
        ${task.checklist.length ? `<div class="progress progress-sm"><span style="width:${(doneCount / task.checklist.length) * 100}%"></span></div>` : ''}
        <ul class="checklist">
          ${task.checklist.map((c) => `
            <li>
              <label><input type="checkbox" data-check="${c.id}" ${c.done ? 'checked' : ''} /> <span class="${c.done ? 'done' : ''}">${esc(c.text)}</span></label>
              <button class="icon-btn icon-btn-sm" data-uncheck="${c.id}" aria-label="Eliminar elemento">✕</button>
            </li>`).join('')}
        </ul>
        <form class="inline-form" data-form="check"><input name="text" placeholder="Añadir elemento..." /><button class="btn btn-sm">Añadir</button></form>
      </section>

      <section class="drawer-section">
        <h4>Fotos <span class="muted small">${task.photoIds.length || ''}</span></h4>
        <div class="photos">
          ${photoUrls.map((u, i) => `
            <div class="photo">
              <img src="${u}" alt="Foto ${i + 1}" data-photo="${i}" />
              <button class="photo-del write" data-delphoto="${task.photoIds[i]}" aria-label="Eliminar foto">✕</button>
            </div>`).join('')}
          <button class="photo-add write" data-act="photo">＋<small>Añadir foto</small></button>
        </div>
      </section>

      <section class="drawer-section">
        <h4>Comentarios</h4>
        <ul class="comments">
          ${task.comments.map((c) => `
            <li><div class="comment-head"><strong>${esc(c.by)}</strong> <span class="muted small">${esc(fmtDateTime(c.at))}</span></div><p>${esc(c.text)}</p></li>`).join('') || '<li class="muted small">Sin comentarios todavía.</li>'}
        </ul>
        <form class="inline-form" data-form="comment"><input name="text" placeholder="Escribe un comentario como ${esc(me)}..." /><button class="btn btn-sm btn-primary">Enviar</button></form>
      </section>

      <section class="drawer-section">
        <h4>Historial</h4>
        <ul class="activity">
          ${[...task.activity].reverse().map((a) => `<li><span class="muted small">${esc(fmtDateTime(a.at))}</span> ${esc(a.text)}${a.by ? ` <span class="muted">· ${esc(a.by)}</span>` : ''}</li>`).join('')}
        </ul>
      </section>
      </fieldset>
    </div>`;

  const save = async (text) => {
    await saveTask(task, text, me);
    notify(ctx, task);
    await renderDrawer(ctx, task);
  };

  drawer.querySelector('[data-act=close]').onclick = closeTaskDrawer;
  drawer.querySelector('[data-act=delete]').onclick = async () => {
    if (!(await confirmDialog(`¿Eliminar la tarea #${task.number}? Esta acción no se puede deshacer.`))) return;
    for (const id of task.photoIds) await deleteFile(id);
    await db.del('tasks', task.id);
    closeTaskDrawer();
    toast('Tarea eliminada');
    notify(ctx, { ...task, deleted: true });
  };

  drawer.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (b.dataset.status === task.status) return;
      const prev = statusOf(task.status);
      const next = statusOf(b.dataset.status);
      task.status = next.id;
      if (prev.open && !next.open) task.completedAt = Date.now();
      if (next.open) task.completedAt = null;
      await save(`Estado: ${prev.short} → ${next.short}`);
    })
  );

  drawer.querySelectorAll('[data-field]').forEach((el) =>
    el.addEventListener('change', async () => {
      const f = el.dataset.field;
      let value = el.value;
      if (f === 'tags') value = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (f === 'title' && !value.trim()) {
        el.value = task.title;
        return;
      }
      const labels = { title: 'Título', category: 'Categoría', startDate: 'Inicio', dueDate: 'Vencimiento', location: 'Ubicación', description: 'Descripción', tags: 'Etiquetas' };
      task[f] = value;
      let text = `${labels[f] || f} actualizado`;
      if (f === 'assigneeId') text = `Asignada a ${ctx.member(value)?.name || 'nadie'}`;
      await save(text);
    })
  );

  drawer.querySelector('[data-act=unpin]')?.addEventListener('click', async () => {
    task.sheetId = '';
    task.x = task.y = null;
    await save('Quitada del plano');
  });
  drawer.querySelector('[data-act=place]')?.addEventListener('click', () => {
    const sid = drawer.querySelector('#place-sheet').value;
    if (!sid) return toast('Selecciona un plano', 'error');
    location.hash = `#/p/${ctx.project.id}/plans/${sid}?place=${task.id}`;
  });

  drawer.querySelector('[data-form=check]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    task.checklist.push({ id: uid(), text, done: false });
    await save(`Elemento añadido: ${text}`);
    drawer.querySelector('[data-form=check] input')?.focus();
  });
  drawer.querySelectorAll('[data-check]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const item = task.checklist.find((c) => c.id === cb.dataset.check);
      item.done = cb.checked;
      await save(`${item.done ? 'Marcado' : 'Desmarcado'}: ${item.text}`);
    })
  );
  drawer.querySelectorAll('[data-uncheck]').forEach((b) =>
    b.addEventListener('click', async () => {
      task.checklist = task.checklist.filter((c) => c.id !== b.dataset.uncheck);
      await save('Elemento de verificación eliminado');
    })
  );

  drawer.querySelector('[data-act=photo]').addEventListener('click', async () => {
    const files = await choosePhotos({ title: `Fotos de la tarea #${task.number}` });
    if (!files.length) return;
    const ids = await savePhotos(ctx.project.id, files);
    if (ids.length < files.length) toast(`${files.length - ids.length} foto(s) no se pudieron leer`, 'error');
    if (!ids.length) return;
    task.photoIds.push(...ids);
    await save(`${ids.length} foto(s) añadida(s)`);
  });
  drawer.querySelectorAll('[data-photo]').forEach((img) =>
    img.addEventListener('click', () => {
      modal({ title: `Foto ${Number(img.dataset.photo) + 1} · Tarea #${task.number}`, body: `<img class="lightbox-img" src="${img.src}" alt="" />`, wide: true });
    })
  );
  drawer.querySelectorAll('[data-delphoto]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Eliminar esta foto?'))) return;
      await deleteFile(b.dataset.delphoto);
      task.photoIds = task.photoIds.filter((id) => id !== b.dataset.delphoto);
      await save('Foto eliminada');
    })
  );

  drawer.querySelector('[data-form=comment]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    task.comments.push({ id: uid(), by: me, at: Date.now(), text });
    await save('Comentario añadido');
  });
}

