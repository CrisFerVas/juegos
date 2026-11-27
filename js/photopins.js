// Fotos de obra colocadas sobre el plano.
// Cada punto de fotos es un documento del almacén "markups" con type 'photo':
// { points: [[x, y]], photoIds: [...], caption, author, createdAt }  (coordenadas normalizadas 0-1)

import { db, uid, fileUrl, fileBlob, saveFile, deleteFile } from './db.js';
import { esc, modal, toast, confirmDialog, choosePhotos, userName, fmtDateTime, ICON_PHOTO_PIN } from './ui.js';
import { savePhotos } from './media.js';
import { mountAnnotatedPhoto, openPhotoAnnotator, deletePhotoMarkups, copyPhotoMarkups } from './photoannotate.js';

export async function loadPhotoPins(projectId, sheetId) {
  return (await db.byProject('markups', projectId)).filter((m) => m.type === 'photo' && m.sheetId === sheetId);
}

/** HTML de los iconos de cámara (en la capa de pines, tamaño constante en pantalla). */
export function photoPinsHTML(pins, W, H) {
  return pins
    .map((p) => {
      const n = p.photoIds.length;
      return `<button class="photo-pin" data-photo-pin="${esc(p.id)}" style="left:${p.points[0][0] * W}px;top:${p.points[0][1] * H}px"
        title="${esc(p.caption || `${n} foto(s)`)}" aria-label="Ver ${n} foto(s)">${ICON_PHOTO_PIN}${n > 1 ? `<span class="photo-pin-count">${n}</span>` : ''}</button>`;
    })
    .join('');
}

/** Pide las fotos (cámara o galería), una descripción opcional, y guarda el punto. */
export async function addPhotoPin(ctx, sheet, point) {
  const files = await choosePhotos({ title: 'Foto en este punto del plano' });
  if (!files.length) return null;
  const previews = files.slice(0, 8).map((f) => URL.createObjectURL(f));
  return new Promise((resolve) => {
    let saved = null;
    const { el } = modal({
      title: files.length > 1 ? `${files.length} fotos` : 'Nueva foto',
      sheet: true,
      body: `
        <div class="photo-previews">${previews.map((u) => `<img src="${u}" alt="" />`).join('')}${files.length > 8 ? `<span class="muted small">+${files.length - 8}</span>` : ''}</div>
        <label class="field"><span>Descripción (opcional)</span>
          <textarea id="photo-caption" name="caption" rows="2" placeholder="Ej. Fisura en el encuentro del conducto con el forjado"></textarea></label>
        <p class="muted small" id="photo-status"></p>`,
      submitLabel: 'Guardar en el plano',
      onSubmit: async (v, form) => {
        form.querySelector('[type=submit]').disabled = true;
        const status = form.querySelector('#photo-status');
        const ids = await savePhotos(ctx.project.id, files, (i, n) => (status.textContent = `Procesando foto ${i} de ${n}...`));
        if (!ids.length) {
          toast('No se pudo leer ninguna foto (formato no compatible)', 'error');
          return;
        }
        if (ids.length < files.length) toast(`${files.length - ids.length} foto(s) no se pudieron leer`, 'error');
        saved = {
          id: uid(),
          projectId: ctx.project.id,
          sheetId: sheet.id,
          type: 'photo',
          points: [[point.x, point.y]],
          photoIds: ids,
          caption: v.caption.trim(),
          author: userName(),
          createdAt: Date.now(),
        };
        await db.put('markups', saved);
        toast(ids.length > 1 ? `${ids.length} fotos añadidas al plano` : 'Foto añadida al plano');
      },
    });
    const obs = new MutationObserver(() => {
      if (!el.isConnected) {
        obs.disconnect();
        previews.forEach((u) => URL.revokeObjectURL(u));
        resolve(saved);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

/**
 * Visor de fotos a pantalla completa con deslizamiento entre fotos.
 * `actions`: { canEdit, onChange(), onCreateTask(pin, photoIds) }
 */
const ICON_EYE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_MOVE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';

/** Menú de una foto del plano (pulsación larga): ver, mover o eliminar. */
export function photoPinMenu(pin, { view, move, remove }) {
  const n = pin.photoIds.length;
  const { el, close } = modal({
    title: pin.caption || (n > 1 ? `${n} fotos` : 'Foto'),
    sheet: true,
    body: `
      <div class="photo-source">
        <button type="button" class="source-btn" data-act="view">${ICON_EYE}<span><strong>Ver ${n > 1 ? 'fotos' : 'foto'}</strong><small>Abrir, anotar o añadir más</small></span></button>
        <button type="button" class="source-btn" data-act="move">${ICON_MOVE}<span><strong>Mover</strong><small>Toca el nuevo punto en el plano</small></span></button>
        <button type="button" class="source-btn source-danger" data-act="remove">${ICON_TRASH}<span><strong>Eliminar</strong><small>${n > 1 ? `Borra el punto y sus ${n} fotos` : 'Borra el punto y su foto'}</small></span></button>
      </div>`,
  });
  const acts = { view, move, remove };
  el.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      close();
      acts[b.dataset.act]?.();
    })
  );
}

/** Borra del todo los archivos de unas fotos y sus anotaciones. */
export async function purgePhotoFiles(ctx, ids) {
  for (const id of ids) {
    await deleteFile(id);
    await deletePhotoMarkups(ctx.project.id, id);
  }
}

/**
 * Elimina un punto de fotos tras confirmar. Devuelve true si se eliminó.
 * Con `keepFiles`, los archivos se conservan (para poder deshacer) y quien llama decide cuándo borrarlos.
 */
export async function deletePhotoPin(ctx, pin, { keepFiles = false } = {}) {
  const n = pin.photoIds.length;
  if (!(await confirmDialog(n > 1 ? `¿Eliminar este punto y sus ${n} fotos?` : '¿Eliminar esta foto del plano?'))) return false;
  await db.del('markups', pin.id);
  if (!keepFiles) await purgePhotoFiles(ctx, pin.photoIds);
  toast(`${n > 1 ? 'Fotos eliminadas' : 'Foto eliminada'}${keepFiles ? ' · puedes deshacerlo con ↶' : ''}`);
  return true;
}

/**
 * Visor de las fotos de un punto. Con `record(antes, después)` (copias del punto, o null si no existe)
 * los borrados se pueden deshacer: los archivos no se eliminan y se avisa con `deferFiles(ids)`.
 */
export async function openPhotoViewer(ctx, pin, { canEdit, onChange, onCreateTask, record = null, deferFiles = null }) {
  const snap = () => structuredClone(pin);
  let index = 0;
  let current = null; // foto montada (con anotaciones)
  const urls = await Promise.all(pin.photoIds.map(fileUrl));
  const { el, close } = modal({ title: pin.caption || 'Fotos', full: true, body: '<div class="pv"></div>' });
  const root = el.querySelector('.pv');
  const titleEl = el.querySelector('.modal-head h2');

  const draw = () => {
    const n = pin.photoIds.length;
    titleEl.textContent = n > 1 ? `Foto ${index + 1} de ${n}` : 'Foto';
    root.innerHTML = `
      <div class="pv-stage">
        <div class="pv-photo" id="pv-photo"></div>
        ${n > 1 ? `
          <button type="button" class="pv-nav prev" aria-label="Foto anterior" ${index === 0 ? 'disabled' : ''}>‹</button>
          <button type="button" class="pv-nav next" aria-label="Foto siguiente" ${index === n - 1 ? 'disabled' : ''}>›</button>
          <div class="pv-dots">${pin.photoIds.map((_, i) => `<span class="${i === index ? 'on' : ''}"></span>`).join('')}</div>` : ''}
      </div>
      <div class="pv-info">
        <p class="muted small">${esc(pin.author || '')}${pin.author ? ' · ' : ''}${esc(fmtDateTime(pin.createdAt))}</p>
        ${canEdit
          ? `<textarea class="pv-caption" id="pv-caption" rows="2" placeholder="Añade una descripción...">${esc(pin.caption || '')}</textarea>`
          : pin.caption ? `<p>${esc(pin.caption)}</p>` : ''}
        <div class="pv-actions">
          ${canEdit ? `
            <button type="button" class="btn btn-primary" data-pv="annotate">✎ Anotar foto</button>
            <button type="button" class="btn" data-pv="add">＋ Añadir fotos</button>
            <button type="button" class="btn" data-pv="task">Crear tarea con las fotos</button>
            <button type="button" class="btn" data-pv="delete-one">Eliminar esta foto</button>
            <button type="button" class="btn btn-danger" data-pv="delete-all">Eliminar punto</button>` : ''}
        </div>
      </div>`;
    // Foto con sus anotaciones
    mountAnnotatedPhoto(root.querySelector('#pv-photo'), ctx, pin.photoIds[index], { zoomable: true, onSwipe: (d) => go(d) }).then((v) => {
      if (current) current.destroy();
      current = v;
    });
    root.querySelector('[data-pv=annotate]')?.addEventListener('click', async () => {
      await openPhotoAnnotator(ctx, pin.photoIds[index]);
      draw();
    });
    root.querySelector('.prev')?.addEventListener('click', () => go(-1));
    root.querySelector('.next')?.addEventListener('click', () => go(1));
    root.querySelector('#pv-caption')?.addEventListener('change', async (e) => {
      pin.caption = e.target.value.trim();
      await db.put('markups', pin);
      onChange?.();
    });
    root.querySelector('[data-pv=add]')?.addEventListener('click', async () => {
      const files = await choosePhotos({ title: 'Añadir fotos a este punto' });
      if (!files.length) return;
      const ids = await savePhotos(ctx.project.id, files);
      if (!ids.length) return toast('No se pudo leer ninguna foto', 'error');
      const before = snap();
      pin.photoIds.push(...ids);
      urls.push(...(await Promise.all(ids.map(fileUrl))));
      await db.put('markups', pin);
      record?.(before, snap());
      index = pin.photoIds.length - 1;
      toast(`${ids.length} foto(s) añadida(s)`);
      onChange?.();
      draw();
    });
    root.querySelector('[data-pv=task]')?.addEventListener('click', async () => {
      // La tarea recibe copias de las fotos: así cada una se puede borrar por separado
      const copies = [];
      for (const id of pin.photoIds) {
        const blob = await fileBlob(id);
        if (!blob) continue;
        const copy = await saveFile(ctx.project.id, blob, 'foto.jpg');
        await copyPhotoMarkups(ctx.project.id, id, copy); // las anotaciones viajan con la foto
        copies.push(copy);
      }
      close();
      onCreateTask?.(pin, copies);
    });
    root.querySelector('[data-pv=delete-one]')?.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Eliminar esta foto?'))) return;
      const before = snap();
      const [id] = pin.photoIds.splice(index, 1);
      urls.splice(index, 1);
      if (!pin.photoIds.length) {
        await db.del('markups', pin.id);
        close();
      } else {
        await db.put('markups', pin);
        index = Math.min(index, pin.photoIds.length - 1);
        draw();
      }
      if (record) {
        record(before, pin.photoIds.length ? snap() : null);
        deferFiles?.([id]);
        toast('Foto eliminada · puedes deshacerlo con ↶');
      } else {
        await purgePhotoFiles(ctx, [id]);
        toast('Foto eliminada');
      }
      onChange?.();
    });
    root.querySelector('[data-pv=delete-all]')?.addEventListener('click', async () => {
      const before = snap();
      if (!(await deletePhotoPin(ctx, pin, { keepFiles: !!record }))) return;
      if (record) {
        record(before, null);
        deferFiles?.(before.photoIds);
      }
      close();
      onChange?.();
    });
  };
  const go = (d) => {
    const next = index + d;
    if (next < 0 || next >= pin.photoIds.length) return;
    index = next;
    draw();
  };

  const onKey = (e) => {
    if (!el.isConnected) return document.removeEventListener('keydown', onKey);
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
  draw();
}
