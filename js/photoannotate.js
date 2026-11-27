// Anotaciones sobre fotos: las mismas herramientas que en los planos, sin las de medición.
// Las anotaciones de una foto son documentos "markups" con sheetId = 'photo:<id del archivo>'.

import { db, fileUrl, uid } from './db.js';
import { toast } from './ui.js';
import { createMarkupLayer, MARKUP_TOOLS, MARKUP_COLORS, MARKUP_WIDTHS } from './markup.js';

export const photoKey = (fileId) => `photo:${fileId}`;
const PHOTO_TOOLS = ['pen', 'marker', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'text', 'eraser'];
const LONG_PRESS_MS = 450;
const TAP_TOLERANCE = 6;

/**
 * Muestra una foto con sus anotaciones, ajustada al contenedor.
 * Devuelve { layer, toPhoto(x, y), destroy() } o null si la foto no está disponible.
 */
export async function mountAnnotatedPhoto(container, ctx, fileId) {
  const url = await fileUrl(fileId);
  if (!url) {
    container.innerHTML = '<p class="pv-missing">Foto no disponible sin conexión</p>';
    return null;
  }
  const img = new Image();
  img.src = url;
  img.alt = '';
  img.draggable = false;
  img.className = 'photo-stage-img';
  try {
    await img.decode();
  } catch {
    /* se mostrará igualmente al cargar */
  }
  const W = img.naturalWidth || 1600, H = img.naturalHeight || 1200;
  container.innerHTML = '';
  container.classList.add('photo-frame');
  const stage = document.createElement('div');
  stage.className = 'photo-stage';
  Object.assign(stage.style, { width: `${W}px`, height: `${H}px` });
  stage.appendChild(img);
  container.appendChild(stage);

  let scale = 1;
  const layer = createMarkupLayer({ ctx, sheet: { id: photoKey(fileId), width: W, height: H }, stage, getScale: () => scale });
  const fit = () => {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    scale = Math.min(r.width / W, r.height / H);
    stage.style.transform = `translate(${(r.width - W * scale) / 2}px, ${(r.height - H * scale) / 2}px) scale(${scale})`;
    layer.refreshSelection();
  };
  fit();
  await layer.load();
  const ro = new ResizeObserver(fit);
  ro.observe(container);
  return {
    layer,
    toPhoto(clientX, clientY) {
      const r = stage.getBoundingClientRect();
      return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
    },
    destroy: () => ro.disconnect(),
  };
}

const toolIcon = (id) => MARKUP_TOOLS.find((t) => t.id === id);

/**
 * Asigna la acción de un botón al levantar el dedo sobre él (además del clic), sin duplicarla.
 * Algunos navegadores móviles descartan el clic del primer toque que sigue a un trazo.
 */
function onTap(btn, fn) {
  if (!btn) return;
  let downOnIt = false;
  let last = -Infinity;
  const run = (e) => {
    if (btn.disabled || performance.now() - last < 500) return;
    last = performance.now();
    fn(e);
  };
  btn.addEventListener('pointerdown', () => (downOnIt = true));
  btn.addEventListener('pointerup', (e) => {
    if (downOnIt) run(e);
    downOnIt = false;
  });
  btn.addEventListener('pointerleave', () => (downOnIt = false));
  btn.addEventListener('click', run);
}

/** Editor de anotaciones a pantalla completa para una foto. Resuelve al cerrarse. */
export function openPhotoAnnotator(ctx, fileId) {
  return new Promise(async (resolve) => {
    const el = document.createElement('div');
    el.className = 'photo-editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Anotar foto');
    el.innerHTML = `
      <header class="pe-head">
        <strong>Anotar foto</strong>
        <span class="pe-hint muted small" id="pe-hint">Dibuja con el dedo · mantén pulsada una anotación para moverla</span>
        <button type="button" class="btn btn-primary btn-sm" id="pe-done">Listo</button>
      </header>
      <div class="pe-area" id="pe-area"></div>
      <div class="markup-bar pe-bar" id="pe-tools" role="toolbar" aria-label="Herramientas de anotación">
        <div class="markup-group">
          ${PHOTO_TOOLS.map((id) => `<button class="markup-tool" data-tool="${id}" title="${toolIcon(id).n}" aria-label="${toolIcon(id).n}">${toolIcon(id).i}</button>`).join('')}
        </div>
        <div class="markup-group">
          ${MARKUP_COLORS.map((c) => `<button class="markup-color" data-color="${c.c}" style="--mc:${c.c}" title="${c.n}" aria-label="Color ${c.n}"></button>`).join('')}
        </div>
        <div class="markup-group">
          ${MARKUP_WIDTHS.map((w) => `<button class="markup-width" data-width="${w.w}" title="${w.n}" aria-label="Grosor ${w.n}"><span style="height:${w.w + 1}px"></span></button>`).join('')}
          <button class="markup-tool" id="pe-undo" title="Deshacer" aria-label="Deshacer"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
        </div>
      </div>
      <div class="markup-bar pe-bar hidden" id="pe-sel" role="toolbar" aria-label="Anotación seleccionada">
        <div class="markup-group"><span class="sel-label">Seleccionada</span></div>
        <div class="markup-group">
          ${MARKUP_COLORS.map((c) => `<button class="markup-color" data-sel-color="${c.c}" style="--mc:${c.c}" title="${c.n}" aria-label="Cambiar a ${c.n}"></button>`).join('')}
        </div>
        <div class="markup-group">
          <button class="markup-tool" id="pe-del" title="Eliminar anotación" aria-label="Eliminar anotación"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
          <button class="btn btn-sm" id="pe-seldone">Hecho</button>
        </div>
      </div>`;
    // En la misma capa que los diálogos: queda encima del visor de fotos, y los diálogos
    // que se abran después (p. ej. el texto) quedan encima del editor.
    document.getElementById('modal-root').appendChild(el);
    const area = el.querySelector('#pe-area');
    const view = await mountAnnotatedPhoto(area, ctx, fileId);
    if (!view) {
      el.remove();
      toast('No se pudo abrir la foto', 'error');
      return resolve();
    }
    const { layer } = view;
    if (!PHOTO_TOOLS.includes(layer.settings.tool)) layer.setTool('pen');

    const toolsBar = el.querySelector('#pe-tools');
    const selBar = el.querySelector('#pe-sel');
    const sync = () => {
      const s = layer.settings;
      toolsBar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === s.tool));
      toolsBar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === s.color));
      toolsBar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === s.width));
      el.querySelector('#pe-undo').disabled = !layer.canUndo();
      const sel = layer.selected();
      toolsBar.classList.toggle('hidden', !!sel);
      selBar.classList.toggle('hidden', !sel);
      if (sel) selBar.querySelectorAll('[data-sel-color]').forEach((b) => b.classList.toggle('active', b.dataset.selColor === sel.color));
      const hints = { text: 'Toca donde quieres escribir', eraser: 'Toca o arrastra sobre una anotación para borrarla' };
      el.querySelector('#pe-hint').textContent = sel ? 'Arrastra para mover · usa los círculos para cambiar el tamaño' : hints[s.tool] || 'Dibuja con el dedo · mantén pulsada una anotación para moverla';
    };
    layer.onSelectionChange(sync);
    toolsBar.querySelectorAll('[data-tool]').forEach((b) => onTap(b, () => { layer.setTool(b.dataset.tool); sync(); }));
    toolsBar.querySelectorAll('[data-color]').forEach((b) => onTap(b, () => { layer.setColor(b.dataset.color); sync(); }));
    toolsBar.querySelectorAll('[data-width]').forEach((b) => onTap(b, () => { layer.setWidth(Number(b.dataset.width)); sync(); }));
    onTap(el.querySelector('#pe-undo'), async () => { await layer.undo(); sync(); });
    selBar.querySelectorAll('[data-sel-color]').forEach((b) => onTap(b, async () => { await layer.recolorSelected(b.dataset.selColor); sync(); }));
    onTap(el.querySelector('#pe-del'), async () => { await layer.deleteSelected(); sync(); });
    onTap(el.querySelector('#pe-seldone'), () => { layer.deselect(); sync(); });
    onTap(el.querySelector('#pe-done'), () => {
      layer.deselect();
      view.destroy();
      // Se oculta y se retira un instante después: así absorbe el "clic" que sigue al toque
      // y no cierra por error el visor que hay debajo.
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
      resolve();
    });

    // ---------- Gestos ----------
    let g = null;
    let timer = null;
    area.addEventListener('pointerdown', (e) => {
      if (g) { // segundo dedo: se cancela el trazo en curso
        if (g.type === 'draw') layer.cancel();
        g = { type: 'ignore' };
        return;
      }
      area.setPointerCapture(e.pointerId);
      const p = view.toPhoto(e.clientX, e.clientY);
      const start = { x: e.clientX, y: e.clientY };
      if (layer.selected()) {
        const part = layer.pickSelection(p);
        if (part) {
          layer.beginEdit(part, p);
          g = { type: 'edit', start };
          return;
        }
        layer.deselect();
      }
      const tool = layer.settings.tool;
      if (tool === 'eraser') {
        g = { type: 'erase', start };
        layer.eraseAt(p).then(sync);
        return;
      }
      g = tool === 'text' ? { type: 'tap', start } : layer.start(p) ? { type: 'draw', start } : { type: 'tap', start };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!g || g.moved || !['draw', 'tap'].includes(g.type)) return;
        const item = layer.hitTest(p);
        if (!item) return;
        if (g.type === 'draw') layer.cancel();
        layer.select(item);
        layer.beginEdit('move', p);
        g = { type: 'edit', start };
        navigator.vibrate?.(15);
        sync();
      }, LONG_PRESS_MS);
    });
    area.addEventListener('pointermove', (e) => {
      if (!g || g.type === 'ignore') return;
      if (!g.moved && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > TAP_TOLERANCE) {
        g.moved = true;
        clearTimeout(timer);
      }
      const p = view.toPhoto(e.clientX, e.clientY);
      if (g.type === 'edit') layer.editTo(p);
      else if (g.type === 'draw') layer.move(p);
      else if (g.type === 'erase') layer.eraseAt(p).then(sync);
    });
    const end = async (e) => {
      clearTimeout(timer);
      const cur = g;
      g = null;
      if (!cur) return;
      if (cur.type === 'edit') await layer.endEdit();
      else if (cur.type === 'draw') e.type === 'pointercancel' ? layer.cancel() : await layer.end();
      else if (cur.type === 'tap' && !cur.moved && layer.settings.tool === 'text') {
        const p = view.toPhoto(e.clientX, e.clientY);
        if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) layer.addText(p);
      }
      sync();
      setTimeout(sync, 400); // tras añadir un texto
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
    sync();
  });
}

/** Borra las anotaciones de una foto (al eliminarla). */
export async function deletePhotoMarkups(projectId, fileId) {
  for (const m of await db.byProject('markups', projectId)) if (m.sheetId === photoKey(fileId)) await db.del('markups', m.id);
}

/** Copia las anotaciones de una foto a su copia (p. ej. al crear una tarea con las fotos). */
export async function copyPhotoMarkups(projectId, fromFileId, toFileId) {
  for (const m of await db.byProject('markups', projectId)) {
    if (m.sheetId !== photoKey(fromFileId)) continue;
    const { _rev, ...rest } = m;
    await db.put('markups', { ...rest, id: uid(), sheetId: photoKey(toFileId) });
  }
}
