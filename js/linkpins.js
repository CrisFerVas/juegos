// Enlaces a otros planos y archivos adjuntos (videos, documentos...) colocados sobre el plano.
// Son documentos del almacén "markups" (se sincronizan como el resto):
//   { type: 'link',   points: [[x, y]], targetSheetId, label }   → al tocarlo se abre ese plano
//   { type: 'attach', points: [[x, y]], fileIds: [...], caption } → al tocarlo se ven o descargan los archivos
// Los videos se reducen a 720p / 30 fps antes de guardarlos (video.js).

import { db, uid, fileUrl, saveFile, deleteFile } from './db.js';
import { esc, modal, toast, confirmDialog, pickFiles, userName, fmtDateTime } from './ui.js';
import { icon } from './icons.js';
import { normPath, prettyPath } from './folders.js';
import { mountAnnotatedPhoto } from './photoannotate.js';
import { isVideo, needsCompression, compressVideo, canCompressVideo, MAX_SHORT, FPS } from './video.js';

export const ICON_LINK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
export const ICON_ATTACH = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7"/></svg>';
const ICON_VIDEO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>';

export async function loadLinkPins(projectId, sheetId) {
  return (await db.byProject('markups', projectId)).filter((m) => (m.type === 'link' || m.type === 'attach') && m.sheetId === sheetId);
}

const sheetLabel = (s) => (s ? (s.docId ? `${s.docName} · pág. ${s.docPage}` : s.name) : '');

/** HTML de los enlaces y adjuntos (en la capa de pines, tamaño constante en pantalla). */
export function linkPinsHTML(pins, ctx, W, H) {
  return pins
    .map((p) => {
      const pos = `left:${p.points[0][0] * W}px;top:${p.points[0][1] * H}px`;
      if (p.type === 'link') {
        const target = ctx.sheet(p.targetSheetId);
        const label = sheetLabel(target) || p.label || 'Plano eliminado';
        return `<button class="link-pin ${target ? '' : 'broken'}" data-link-pin="${esc(p.id)}" style="${pos}" title="Abrir ${esc(label)}" aria-label="Enlace al plano ${esc(label)}">
          <span class="link-dot">${ICON_LINK}</span><span class="link-label">${esc(label)}</span></button>`;
      }
      const n = p.fileIds.length;
      return `<button class="photo-pin attach-pin" data-attach-pin="${esc(p.id)}" style="${pos}" title="${esc(p.caption || `${n} archivo(s)`)}" aria-label="Ver ${n} archivo(s) adjunto(s)">${ICON_ATTACH}${n > 1 ? `<span class="photo-pin-count">${n}</span>` : ''}</button>`;
    })
    .join('');
}

// ---------- Enlaces a planos ----------

/** Selector de plano destino (agrupado por carpeta, sin el plano actual). */
function sheetPicker(ctx, excludeId, selectedId = '') {
  const groups = new Map();
  for (const s of ctx.sheets) {
    if (s.id === excludeId) continue;
    const f = normPath(s.folder);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(s);
  }
  const opt = (s) => `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${esc(sheetLabel(s))}</option>`;
  return `<select name="target" required size="1"><option value="">Elige un plano...</option>${[...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true }))
    .map(([f, list]) => `<optgroup label="${esc(prettyPath(f))}">${list.map(opt).join('')}</optgroup>`)
    .join('')}</select>`;
}

/** Pide el plano destino y guarda el enlace en ese punto. Devuelve el documento o null. */
export function addLinkPin(ctx, sheet, point, existing = null) {
  if (ctx.sheets.length < 2) {
    toast('Sube al menos otro plano para poder enlazarlo', 'error');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let saved = null;
    const { el } = modal({
      title: existing ? 'Cambiar el plano enlazado' : 'Enlace a otro plano',
      sheet: true,
      body: `
        <label class="field"><span>Plano que se abrirá al tocar el enlace *</span>${sheetPicker(ctx, sheet.id, existing?.targetSheetId)}</label>
        <p class="muted small">En el plano se verá un punto con el nombre del plano enlazado. Tócalo para abrirlo.</p>`,
      submitLabel: existing ? 'Guardar' : 'Crear enlace',
      onSubmit: async (v) => {
        const target = ctx.sheet(v.target);
        if (!target) {
          toast('Elige el plano que quieres enlazar', 'error');
          return false;
        }
        saved = existing
          ? { ...existing, targetSheetId: target.id, label: sheetLabel(target) }
          : {
              id: uid(),
              projectId: ctx.project.id,
              sheetId: sheet.id,
              type: 'link',
              points: [[point.x, point.y]],
              targetSheetId: target.id,
              label: sheetLabel(target),
              author: userName(),
              createdAt: Date.now(),
            };
        await db.put('markups', saved);
        toast(existing ? 'Enlace actualizado' : `Enlace a «${sheetLabel(target)}» creado`);
      },
    });
    whenClosed(el, () => resolve(saved));
  });
}

// ---------- Archivos adjuntos (videos y otros) ----------

/** Elige archivos: grabar un video con la cámara del teléfono o escoger videos/archivos. */
function chooseAttachments() {
  return new Promise((resolve) => {
    let picked = false;
    const { el, close } = modal({
      title: 'Adjuntar en este punto',
      sheet: true,
      body: `
        <div class="photo-source">
          <button type="button" class="source-btn" data-src="record">${ICON_VIDEO}<span><strong>Grabar video</strong><small>Abre la cámara de video del teléfono</small></span></button>
          <button type="button" class="source-btn" data-src="pick">${ICON_ATTACH}<span><strong>Elegir videos o archivos</strong><small>Videos, PDF, documentos, hojas de cálculo...</small></span></button>
        </div>
        <p class="muted small">Los videos se reducen a ${MAX_SHORT}p y ${FPS} fps para que pesen poco.</p>`,
    });
    el.querySelectorAll('[data-src]').forEach((b) =>
      b.addEventListener('click', async () => {
        picked = true;
        close();
        const files = b.dataset.src === 'record'
          ? await pickFiles({ accept: 'video/*', capture: 'environment' })
          : await pickFiles({ accept: '*/*', multiple: true });
        resolve(files);
      })
    );
    whenClosed(el, () => !picked && resolve([]));
  });
}

/**
 * Guarda los archivos; los videos se reducen antes a 720p / 30 fps (con progreso y opción de cancelar).
 * Devuelve los ids guardados (vacío si se canceló).
 */
async function saveAttachments(ctx, files) {
  const ids = [];
  const ctrl = new AbortController();
  const { el, close } = modal({
    title: 'Preparando archivos',
    body: `
      <p id="att-name" class="small"></p>
      <div class="progress"><span id="att-bar"></span></div>
      <p id="att-note" class="muted small">No apagues la pantalla ni cambies de app mientras se reduce el video: tarda lo mismo que dura.</p>
      <div class="row-gap"><button type="button" class="btn btn-sm" id="att-cancel">Cancelar</button></div>`,
  });
  el.querySelector('#att-cancel').addEventListener('click', () => ctrl.abort());
  whenClosed(el, () => ctrl.abort());
  const nameEl = el.querySelector('#att-name');
  const bar = el.querySelector('#att-bar');
  const note = el.querySelector('#att-note');
  try {
    for (const [i, file] of files.entries()) {
      if (ctrl.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      let out = file;
      nameEl.textContent = `${i + 1} de ${files.length}: ${file.name}`;
      bar.style.width = '0%';
      if (isVideo(file)) {
        let check = null;
        try {
          check = await needsCompression(file);
        } catch {
          check = null; // no se puede leer: se guarda tal cual
        }
        if (check?.needed && canCompressVideo()) {
          note.hidden = false;
          try {
            out = await compressVideo(file, { signal: ctrl.signal, onProgress: (p) => (bar.style.width = `${Math.round(p * 100)}%`) });
            toast(`Video reducido: ${mb(file.size)} → ${mb(out.size)}`);
          } catch (err) {
            if (err.name === 'AbortError') throw err;
            toast(`No se pudo reducir «${file.name}»: se guarda el original`, 'error');
            out = file;
          }
        } else if (check?.needed) toast('Este navegador no puede reducir videos: se guarda el original', 'error');
      } else note.hidden = true;
      bar.style.width = '100%';
      ids.push(await saveFile(ctx.project.id, out, out.name));
    }
  } catch (err) {
    for (const id of ids) await deleteFile(id);
    close();
    if (err.name !== 'AbortError') toast(err.message || 'No se pudieron guardar los archivos', 'error');
    else toast('Cancelado');
    return [];
  }
  close();
  return ids;
}
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toLocaleString('es', { maximumFractionDigits: 1 })} MB`);

/** Elige archivos, los prepara y guarda el punto de adjuntos. Devuelve el documento o null. */
export async function addAttachPin(ctx, sheet, point) {
  const files = await chooseAttachments();
  if (!files.length) return null;
  const ids = await saveAttachments(ctx, files);
  if (!ids.length) return null;
  const doc = {
    id: uid(),
    projectId: ctx.project.id,
    sheetId: sheet.id,
    type: 'attach',
    points: [[point.x, point.y]],
    fileIds: ids,
    caption: '',
    author: userName(),
    createdAt: Date.now(),
  };
  await db.put('markups', doc);
  toast(ids.length > 1 ? `${ids.length} archivos adjuntados al plano` : 'Archivo adjuntado al plano');
  return doc;
}

/** Ver los archivos de un punto: videos con reproductor, imágenes y el resto para abrir o descargar. */
export async function openAttachViewer(ctx, pin, { canEdit, onChange }) {
  const { el, close } = modal({ title: pin.caption || 'Archivos adjuntos', wide: true, body: '<div class="att-list"></div>' });
  const root = el.querySelector('.att-list');
  const draw = async () => {
    const files = await Promise.all(pin.fileIds.map(async (id) => ({ id, meta: await db.get('files', id), url: await fileUrl(id) })));
    root.innerHTML = `
      <p class="muted small">${esc(pin.author || '')}${pin.author ? ' · ' : ''}${esc(fmtDateTime(pin.createdAt))}</p>
      ${canEdit ? `<textarea class="pv-caption" id="att-caption" rows="2" placeholder="Añade una descripción...">${esc(pin.caption || '')}</textarea>` : pin.caption ? `<p>${esc(pin.caption)}</p>` : ''}
      ${files.map(({ id, meta, url }) => {
        const type = meta?.type || meta?.blob?.type || '';
        const name = meta?.name || 'archivo';
        const size = meta?.size || meta?.blob?.size;
        const media = !url ? '<p class="muted small">Archivo no disponible en este dispositivo (sin conexión).</p>'
          : type.startsWith('video/') ? `<video src="${url}" controls playsinline preload="metadata"></video>`
          : type.startsWith('image/') ? `<div class="att-photo" data-photo="${id}"></div>` : '';
        return `
          <article class="att-item">
            ${media}
            <div class="att-meta">
              <span class="att-icon">${type.startsWith('video/') ? ICON_VIDEO : ICON_FILE}</span>
              <span class="att-name"><strong>${esc(name)}</strong><small class="muted">${size ? mb(size) : ''}</small></span>
              ${url ? `<a class="btn btn-sm" href="${url}" target="_blank" rel="noopener">Abrir</a><a class="btn btn-sm" href="${url}" download="${esc(name)}">${icon('download', 16)}</a>` : ''}
              ${canEdit ? `<button type="button" class="icon-btn icon-btn-sm" data-del="${id}" aria-label="Quitar ${esc(name)}">✕</button>` : ''}
            </div>
          </article>`;
      }).join('')}
      ${canEdit ? `<div class="row-gap"><button type="button" class="btn" id="att-add">＋ Añadir archivos</button><button type="button" class="btn btn-danger" id="att-del-all">Eliminar punto</button></div>` : ''}`;
    // Imágenes con zoom (pellizco, doble toque, Ctrl + rueda), como las fotos del plano
    root.querySelectorAll('[data-photo]').forEach((box) => mountAnnotatedPhoto(box, ctx, box.dataset.photo, { zoomable: true }));
    root.querySelector('#att-caption')?.addEventListener('change', async (e) => {
      pin.caption = e.target.value.trim();
      await db.put('markups', pin);
      onChange?.();
    });
    root.querySelector('#att-add')?.addEventListener('click', async () => {
      const chosen = await chooseAttachments();
      if (!chosen.length) return;
      const ids = await saveAttachments(ctx, chosen);
      if (!ids.length) return;
      pin.fileIds.push(...ids);
      await db.put('markups', pin);
      onChange?.();
      draw();
    });
    root.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmDialog('¿Quitar este archivo?'))) return;
        pin.fileIds = pin.fileIds.filter((x) => x !== b.dataset.del);
        await deleteFile(b.dataset.del);
        if (pin.fileIds.length) await db.put('markups', pin);
        else {
          await db.del('markups', pin.id);
          close();
        }
        onChange?.();
        if (pin.fileIds.length) draw();
      })
    );
    root.querySelector('#att-del-all')?.addEventListener('click', async () => {
      if (await deleteLinkPin(ctx, pin)) {
        close();
        onChange?.();
      }
    });
  };
  draw();
}

/** Elimina un enlace o un punto de adjuntos (con sus archivos) tras confirmar. */
export async function deleteLinkPin(ctx, pin) {
  const msg = pin.type === 'link' ? '¿Eliminar este enlace del plano? El plano enlazado no se borra.'
    : `¿Eliminar este punto y ${pin.fileIds.length > 1 ? `sus ${pin.fileIds.length} archivos` : 'su archivo'}?`;
  if (!(await confirmDialog(msg))) return false;
  await db.del('markups', pin.id);
  for (const id of pin.fileIds || []) await deleteFile(id);
  toast(pin.type === 'link' ? 'Enlace eliminado' : 'Adjuntos eliminados');
  return true;
}

/** Menú por pulsación larga: abrir, mover, cambiar destino o eliminar. */
export function linkPinMenu(pin, acts) {
  const items = pin.type === 'link'
    ? [['open', 'Abrir el plano enlazado'], ['retarget', 'Cambiar el plano enlazado'], ['move', 'Mover'], ['remove', 'Eliminar enlace']]
    : [['open', 'Ver archivos'], ['move', 'Mover'], ['remove', 'Eliminar punto y archivos']];
  const { el, close } = modal({
    title: pin.type === 'link' ? 'Enlace' : 'Archivos adjuntos',
    sheet: true,
    body: `<div class="action-list">${items.map(([k, label]) => `<button type="button" class="action-item ${k === 'remove' ? 'text-danger' : ''}" data-act="${k}">${icon({ open: 'eye', retarget: 'edit', move: 'fit', remove: 'close' }[k])}<span>${label}</span></button>`).join('')}</div>`,
  });
  el.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      close();
      acts[b.dataset.act]?.();
    })
  );
}

function whenClosed(el, fn) {
  const obs = new MutationObserver(() => {
    if (!el.isConnected) {
      obs.disconnect();
      fn();
    }
  });
  obs.observe(document.getElementById('modal-root'), { childList: true });
}
