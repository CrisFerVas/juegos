// Anotaciones sobre fotos: las mismas herramientas que en los planos, sin las de medición.
// Las anotaciones de una foto son documentos "markups" con sheetId = 'photo:<id del archivo>'.

import { db, fileUrl, uid } from './db.js';
import { toast } from './ui.js';
import { createMarkupLayer, MARKUP_TOOLS, MARKUP_COLORS, MARKUP_WIDTHS } from './markup.js';

export const photoKey = (fileId) => `photo:${fileId}`;
const PHOTO_TOOLS = ['pen', 'marker', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'text', 'eraser'];
const LONG_PRESS_MS = 450;
const TAP_TOLERANCE = 6;
const MAX_ZOOM = 8;

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

  // Escala total = escala de ajuste × zoom. (lx, ly) = esquina superior izquierda de la foto en el contenedor.
  let base = 1, zoom = 1, lx = 0, ly = 0, cw = 0, ch = 0;
  let scale = 1;
  const layer = createMarkupLayer({ ctx, sheet: { id: photoKey(fileId), width: W, height: H }, stage, getScale: () => scale });
  let onZoom = () => {};
  const clamp = () => {
    const sw = W * scale, sh = H * scale;
    lx = sw <= cw ? (cw - sw) / 2 : Math.min(0, Math.max(cw - sw, lx));
    ly = sh <= ch ? (ch - sh) / 2 : Math.min(0, Math.max(ch - sh, ly));
  };
  const apply = () => {
    clamp();
    stage.style.transform = `translate(${lx}px, ${ly}px) scale(${scale})`;
    layer.refreshSelection();
    onZoom(zoom);
  };
  const fit = () => {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Mantiene el centro visible al cambiar el tamaño (p. ej. al girar el móvil)
    const cx = cw ? (cw / 2 - lx) / scale : W / 2, cy = ch ? (ch / 2 - ly) / scale : H / 2;
    cw = r.width;
    ch = r.height;
    base = Math.min(cw / W, ch / H);
    scale = base * zoom;
    lx = cw / 2 - cx * scale;
    ly = ch / 2 - cy * scale;
    apply();
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
    /** Zoom (1 = foto entera) alrededor de un punto de la pantalla; por defecto, el centro. */
    zoomAt(factor, clientX, clientY) {
      const r = container.getBoundingClientRect();
      const cx = clientX == null ? cw / 2 : clientX - r.left, cy = clientY == null ? ch / 2 : clientY - r.top;
      const nz = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
      const k = nz / zoom;
      zoom = nz;
      scale = base * zoom;
      lx = cx - (cx - lx) * k;
      ly = cy - (cy - ly) * k;
      apply();
    },
    panBy(dx, dy) {
      lx += dx;
      ly += dy;
      apply();
    },
    resetZoom() {
      zoom = 1;
      scale = base;
      apply();
    },
    get zoom() { return zoom; },
    onZoom(fn) { onZoom = fn; fn(zoom); },
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
        <span class="pe-hint muted small" id="pe-hint">Dibuja con el dedo · dos dedos para hacer zoom y desplazarte</span>
        <div class="pe-zoom" role="group" aria-label="Zoom">
          <button type="button" class="btn btn-sm" id="pe-zout" title="Alejar" aria-label="Alejar">−</button>
          <button type="button" class="btn btn-sm pe-zval" id="pe-zfit" title="Ver la foto entera" aria-label="Ver la foto entera">100%</button>
          <button type="button" class="btn btn-sm" id="pe-zin" title="Acercar" aria-label="Acercar">+</button>
        </div>
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
      el.querySelector('#pe-hint').textContent = sel ? 'Arrastra para mover · usa los círculos para cambiar el tamaño' : hints[s.tool] || 'Dibuja con el dedo · dos dedos para hacer zoom y desplazarte · mantén pulsada una anotación para moverla';
    };
    layer.onSelectionChange(sync);
    toolsBar.querySelectorAll('[data-tool]').forEach((b) => onTap(b, () => { layer.setTool(b.dataset.tool); sync(); }));
    toolsBar.querySelectorAll('[data-color]').forEach((b) => onTap(b, () => { layer.setColor(b.dataset.color); sync(); }));
    toolsBar.querySelectorAll('[data-width]').forEach((b) => onTap(b, () => { layer.setWidth(Number(b.dataset.width)); sync(); }));
    onTap(el.querySelector('#pe-undo'), async () => { await layer.undo(); sync(); });
    selBar.querySelectorAll('[data-sel-color]').forEach((b) => onTap(b, async () => { await layer.recolorSelected(b.dataset.selColor); sync(); }));
    onTap(el.querySelector('#pe-del'), async () => { await layer.deleteSelected(); sync(); });
    onTap(el.querySelector('#pe-seldone'), () => { layer.deselect(); sync(); });
    const zval = el.querySelector('#pe-zfit');
    view.onZoom((z) => {
      zval.textContent = `${Math.round(z * 100)}%`;
      el.querySelector('#pe-zout').disabled = z <= 1;
      el.querySelector('#pe-zin').disabled = z >= MAX_ZOOM;
    });
    onTap(el.querySelector('#pe-zin'), () => view.zoomAt(1.5));
    onTap(el.querySelector('#pe-zout'), () => view.zoomAt(1 / 1.5));
    onTap(zval, () => view.resetZoom());
    area.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)), e.clientX, e.clientY);
    }, { passive: false });

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
    // Un dedo: dibujar / editar. Dos dedos: zoom y desplazamiento (cancela el trazo en curso).
    const pts = new Map();
    let g = null;
    let timer = null;
    const pinchInfo = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    area.addEventListener('pointerdown', async (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      area.setPointerCapture(e.pointerId);
      if (pts.size === 2) {
        clearTimeout(timer);
        if (g?.type === 'draw') layer.cancel();
        else if (g?.type === 'edit') await layer.endEdit();
        g = { type: 'pinch', ...pinchInfo() };
        sync();
        return;
      }
      if (g || pts.size > 2) return; // tercer dedo, o restos de un pellizco
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
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g || g.type === 'ignore') return;
      if (g.type === 'pinch') {
        if (pts.size < 2) return;
        const n = pinchInfo();
        view.panBy(n.mx - g.mx, n.my - g.my);
        view.zoomAt(n.d / g.d, n.mx, n.my);
        Object.assign(g, n);
        return;
      }
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
      if (!pts.delete(e.pointerId)) return;
      clearTimeout(timer);
      const cur = g;
      if (cur && (cur.type === 'pinch' || cur.type === 'ignore')) {
        // Tras un pellizco no se dibuja con el dedo que queda hasta levantarlos todos
        g = pts.size ? { type: 'ignore' } : null;
        return;
      }
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
