import { db, STATUSES, statusOf, saveTask, fileUrl, isOverdue, deleteFile, uid } from '../db.js';
import { esc, toast, avatar, fmtDate, userName, modal } from '../ui.js';
import { openTaskDrawer, newTaskForm } from './taskDetail.js';
import { canEdit } from '../sync.js';
import { createPdfLayer, pdfPageWidthMm } from '../hires.js';
import { createCompare } from '../compare.js';
import { loadPhotoPins, photoPinsHTML, addPhotoPin, openPhotoViewer, photoPinMenu, deletePhotoPin, purgePhotoFiles } from '../photopins.js';
import { createMarkupLayer, MARKUP_TOOLS, MARKUP_COLORS, MARKUP_WIDTHS } from '../markup.js';
import { openExportDialog } from '../exportplan.js';
import { normPath, prettyPath } from '../folders.js';
import { createLoupe } from '../loupe.js';
import { icon } from '../icons.js';

const MIN_SCALE = 0.05;
const TAP_TOLERANCE = 6;
const LONG_PRESS_MS = 450;

const TOOL = Object.fromEntries(MARKUP_TOOLS.map((t) => [t.id, t]));
const railTool = (id) => `<button class="rail-btn" data-tool="${id}" title="${TOOL[id].n}" aria-label="${TOOL[id].n}">${TOOL[id].i}</button>`;
const RAIL_GROUPS = { draw: ['pen', 'marker', 'eraser'], shapes: ['line', 'arrow', 'rect', 'ellipse', 'cloud'], measure: ['measure', 'path', 'area', 'calibrate'] };
/** Botón de la barra que despliega a su izquierda las herramientas de un grupo (muestra la última usada). */
const railGroup = (id, label, tools) => `
  <div class="rail-group" data-group="${id}">
    <button class="rail-btn" data-group-btn="${id}" title="${label}" aria-label="${label}">${TOOL[tools[0]].i}</button>
    <div class="flyout">${tools.map((t) => `<button class="markup-tool" data-tool="${t}" title="${TOOL[t].n}" aria-label="${TOOL[t].n}">${TOOL[t].i}</button>`).join('')}</div>
  </div>`;

export async function renderViewer(view, ctx, sheetId, params) {
  const sheet = ctx.sheet(sheetId);
  if (!sheet) {
    view.innerHTML = `<div class="empty"><h2>Plano no encontrado</h2><a class="btn" href="#/p/${ctx.project.id}/plans">Volver a planos</a></div>`;
    return;
  }
  const src = await fileUrl(sheet.fileId);
  const W = sheet.width, H = sheet.height;
  const versions = [...(sheet.versions || [])].sort((a, b) => b.version - a.version);
  const vDate = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' });
  // Zoom máximo (píxeles de pantalla por píxel de la imagen base). En PDF se redibuja en vectorial,
  // así que se puede ampliar mucho más sin perder nitidez.
  const MAX_SCALE = sheet.pdfFileId ? 16 : 6;

  const state = {
    scale: 1, tx: 0, ty: 0,
    mode: params.get('place') ? 'place' : 'view',
    placeTaskId: params.get('place') || null,
    hidden: new Set(),
    photosVisible: true,
    listOpen: window.innerWidth > 900,
  };

  view.innerHTML = `
    <div class="viewer">
      <div class="viewer-toolbar">
        <a class="icon-btn" href="#/p/${ctx.project.id}/plans${normPath(sheet.folder) ? `?f=${encodeURIComponent(normPath(sheet.folder))}` : ''}" title="Volver a la carpeta del plano" aria-label="Volver">${icon('back')}</a>
        <select id="sheet-switch" class="sheet-switch" aria-label="Cambiar de plano">
          ${sheetOptions(ctx, sheet.id)}
        </select>
        <button class="icon-btn" id="filters-toggle" title="Qué mostrar en el plano" aria-label="Capas y filtros" aria-expanded="false">${icon('eye')}</button>
        <button class="icon-btn" id="viewer-more" title="Más opciones" aria-label="Más opciones" aria-expanded="false">${icon('more')}</button>
        <div class="viewer-pop status-filters" role="group" aria-label="Qué mostrar en el plano">
          <p class="pop-title">Tareas por estado</p>
          <div class="pop-chips">
            ${STATUSES.map((s) => `<button class="chip active" data-filter="${s.id}" style="--c:${s.color}" title="${s.label}">${s.label}</button>`).join('')}
          </div>
          <p class="pop-title">Capas</p>
          <div class="pop-chips">
            <button class="chip active" id="filter-photos" style="--c:#3f8cff" title="Mostrar u ocultar las fotos">Fotos</button>
            <button class="chip active" id="markup-visible" style="--c:#e11d48" title="Ocultar anotaciones" aria-pressed="true">Anotaciones</button>
          </div>
        </div>
        <div class="viewer-pop viewer-menu" id="viewer-menu" role="menu">
          <button class="action-item" id="toggle-list" role="menuitem">${icon('list')}<span>Lista de tareas del plano</span></button>
          ${versions.length ? `<button class="action-item" id="compare-btn" role="menuitem">${icon('compare')}<span>Comparar versiones</span></button>` : ''}
          <button class="action-item" id="export-pdf" role="menuitem">${icon('download')}<span>Descargar PDF con anotaciones</span></button>
          <button class="action-item" id="zoom-fit" role="menuitem">${icon('fit')}<span>Ajustar a la pantalla</span></button>
        </div>
      </div>
      <div class="viewer-main">
        <div class="viewer-canvas" id="canvas">
          <div class="stage" id="stage" style="width:${W}px;height:${H}px">
            <img src="${src}" alt="${esc(sheet.name)}" draggable="false" />
            <div class="pins" id="pins"></div>
          </div>
          <div class="viewer-hint hidden" id="hint"></div>
          <div class="tool-rail" id="view-rail" role="toolbar" aria-label="Herramientas del plano">
            <div class="rail-tools">
              <button class="rail-btn write" id="add-mode" title="Crear una tarea en el plano" aria-label="Nueva tarea">${icon('pin')}</button>
              <button class="rail-btn write" id="photo-mode" title="Añadir fotos en un punto del plano" aria-label="Foto">${icon('camera')}</button>
              <button class="rail-btn write" id="markup-mode" title="Dibujar, escribir y medir sobre el plano" aria-label="Anotar">${icon('pencil')}</button>
              <span class="rail-sep write"></span>
              <button class="rail-btn write" id="hist-undo" title="Deshacer la última acción" aria-label="Deshacer" disabled>${icon('undo')}</button>
              <button class="rail-btn write" id="hist-redo" title="Rehacer" aria-label="Rehacer" disabled>${icon('redo')}</button>
              <span class="rail-sep desk-only"></span>
              <button class="rail-btn desk-only" id="zoom-in" title="Acercar" aria-label="Acercar">${icon('zoomIn')}</button>
              <button class="rail-btn desk-only" id="zoom-out" title="Alejar" aria-label="Alejar">${icon('zoomOut')}</button>
            </div>
            <button class="rail-btn rail-toggle" id="rail-toggle" title="Plegar la barra" aria-label="Plegar o desplegar la barra de herramientas" aria-expanded="true">${icon('chevronDown')}</button>
          </div>
          <button class="version-chip" id="version-chip" ${versions.length ? '' : 'disabled'} title="${versions.length ? 'Comparar con versiones anteriores' : 'Versión actual del plano'}">
            <span>v${sheet.version || 1}${sheet.uploadedAt || sheet.createdAt ? ` · ${vDate.format(sheet.uploadedAt || sheet.createdAt)}` : ''}</span>${versions.length ? icon('chevronUp', 18) : ''}
          </button>
          ${versions.length ? `
          <div class="compare-bar hidden" id="compare-bar" role="toolbar" aria-label="Comparar versiones">
            <label class="compare-pick">v${sheet.version || 1} (actual) frente a
              <select id="compare-version">${versions.map((v) => `<option value="${v.version}">v${v.version}${v.uploadedAt ? ` · ${vDate.format(v.uploadedAt)}` : ''}</option>`).join('')}</select>
            </label>
            <div class="seg-toggle" role="group" aria-label="Modo de comparación">
              <button data-cmode="overlay" class="active">Superposición</button>
              <button data-cmode="curtain">Cortina</button>
            </div>
            <div class="compare-legend" id="compare-legend">
              <span><i style="background:#ff0000"></i>Eliminado</span>
              <span><i style="background:#0000ff"></i>Nuevo</span>
              <span><i style="background:#a3a3a3"></i>Sin cambios</span>
            </div>
            <button class="icon-btn" id="compare-close" title="Cerrar comparación" aria-label="Cerrar comparación">✕</button>
          </div>` : ''}
          <div class="markup-bar hidden" id="sel-bar" role="toolbar" aria-label="Anotación seleccionada">
            <div class="markup-group"><span class="sel-label">Seleccionada</span></div>
            <div class="markup-group">
              ${MARKUP_COLORS.map((c) => `<button class="markup-color" data-sel-color="${c.c}" style="--mc:${c.c}" title="${c.n}" aria-label="Cambiar a ${c.n}"></button>`).join('')}
            </div>
            <div class="markup-group">
              <button class="markup-tool" id="sel-delete" title="Eliminar anotación" aria-label="Eliminar anotación"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
              <button class="btn btn-primary btn-sm" id="sel-done">Listo</button>
            </div>
          </div>
          <div class="markup-layer hidden" id="markup-bar" role="toolbar" aria-label="Herramientas de anotación">
            <div class="tool-rail markup-rail">
              <div class="rail-tools">
                ${railTool('hand')}
                ${railGroup('draw', 'Lápiz, rotulador y borrador', ['pen', 'marker', 'eraser'])}
                ${railGroup('shapes', 'Líneas y formas', ['line', 'arrow', 'rect', 'ellipse', 'cloud'])}
                ${railTool('text')}
                ${railGroup('measure', 'Medir y calibrar', ['measure', 'path', 'area', 'calibrate'])}
                ${railTool('clip')}
                <div class="rail-group" data-group="style">
                  <button class="rail-btn rail-color" data-group-btn="style" title="Color y grosor" aria-label="Color y grosor"><span class="color-dot"></span></button>
                  <div class="flyout flyout-style">
                    <div class="flyout-colors">${MARKUP_COLORS.map((c) => `<button class="markup-color" data-color="${c.c}" style="--mc:${c.c}" title="${c.n}" aria-label="Color ${c.n}"></button>`).join('')}</div>
                    <div class="flyout-widths">${MARKUP_WIDTHS.map((w) => `<button class="markup-width" data-width="${w.w}" title="${w.n}" aria-label="Grosor ${w.n}"><span style="height:${w.w + 1}px"></span></button>`).join('')}</div>
                  </div>
                </div>
                <span class="rail-sep"></span>
                <button class="rail-btn" id="markup-undo" title="Deshacer" aria-label="Deshacer">${icon('undo')}</button>
                <button class="rail-btn" id="markup-redo" title="Rehacer" aria-label="Rehacer">${icon('redo')}</button>
              </div>
              <button class="rail-btn rail-done" id="markup-done" title="Terminar de anotar" aria-label="Listo">${icon('check')}</button>
            </div>
            <div class="markup-ctx">
              <button class="scale-chip" id="scale-chip" title="Escala del plano para las mediciones">Sin escala</button>
              <button class="btn btn-sm btn-primary hidden" id="markup-finish">Terminar</button>
              <button class="btn btn-sm hidden clip-btn" id="clip-cut" title="Borra el resaltado que queda dentro del recuadro">✂ Borrar dentro</button>
              <button class="btn btn-sm hidden clip-btn" id="clip-keep" title="Deja solo el resaltado que queda dentro del recuadro">⬚ Dejar solo dentro</button>
            </div>
          </div>
        </div>
        <aside class="viewer-list" id="list"></aside>
      </div>
    </div>`;

  const canvas = view.querySelector('#canvas');
  const stage = view.querySelector('#stage');
  const pinsEl = view.querySelector('#pins');
  const listEl = view.querySelector('#list');
  const hint = view.querySelector('#hint');
  const addBtn = view.querySelector('#add-mode');
  const photoBtn = view.querySelector('#photo-mode');

  const sheetTasks = () => ctx.tasks.filter((t) => t.sheetId === sheet.id && t.x != null);
  let photoPins = [];
  const reloadPhotos = async () => {
    photoPins = await loadPhotoPins(ctx.project.id, sheet.id);
  };

  // ---------- Transformación ----------
  let pdfLayer = null;
  let markupRef = null;
  let compareRef = null;
  const apply = () => {
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    pdfLayer?.schedule();
    stage.style.setProperty('--inv', 1 / state.scale);
    markupRef?.refreshSelection();
    markupRef?.refreshClipWin();
    compareRef?.update();
  };
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    state.scale = Math.min(r.width / W, r.height / H) * 0.95;
    state.tx = (r.width - W * state.scale) / 2;
    state.ty = (r.height - H * state.scale) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
    const k = next / state.scale;
    state.tx = cx - (cx - state.tx) * k;
    state.ty = cy - (cy - state.ty) * k;
    state.scale = next;
    apply();
  };
  const zoomCenter = (factor) => {
    const r = canvas.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  };
  const centerOn = (x, y, scale) => {
    const r = canvas.getBoundingClientRect();
    if (scale) state.scale = scale;
    state.tx = r.width / 2 - x * W * state.scale;
    state.ty = r.height / 2 - y * H * state.scale;
    apply();
  };
  /** Convierte coordenadas de pantalla en coordenadas normalizadas (0-1) del plano. */
  const toPlan = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - state.tx) / state.scale / W,
      y: (clientY - r.top - state.ty) / state.scale / H,
    };
  };
  const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

  // ---------- Pines y lista ----------
  const drawPins = () => {
    const tasks = sheetTasks().filter((t) => !state.hidden.has(t.status));
    pinsEl.innerHTML = tasks
      .map((t) => {
        const st = statusOf(t.status);
        return `<button class="pin ${isOverdue(t) ? 'pin-overdue' : ''} ${t.id === state.placeTaskId ? 'pin-placing' : ''}" data-pin="${t.id}"
          style="left:${t.x * W}px;top:${t.y * H}px;--c:${st.color}" title="#${t.number} ${esc(t.title)}">${t.number}</button>`;
      })
      .join('') + (state.photosVisible || state.movePhotoId ? photoPinsHTML(photoPins, W, H) : '');
    if (state.movePhotoId) pinsEl.querySelector(`[data-photo-pin="${CSS.escape(state.movePhotoId)}"]`)?.classList.add('pin-moving');
    const all = sheetTasks();
    listEl.innerHTML = `
      <div class="viewer-list-head"><strong>Tareas en este plano</strong><span class="muted small">${tasks.length}/${all.length}</span></div>
      <ul>${tasks
        .sort((a, b) => a.number - b.number)
        .map((t) => `
          <li data-item="${t.id}">
            <span class="dot" style="background:${statusOf(t.status).color}"></span>
            <div class="viewer-list-text">
              <span>#${t.number} ${esc(t.title)}</span>
              <small class="muted ${isOverdue(t) ? 'text-danger' : ''}">${esc(t.category)}${t.dueDate ? ' · ' + esc(fmtDate(t.dueDate)) : ''}</small>
            </div>
            ${avatar(ctx.member(t.assigneeId))}
          </li>`)
        .join('') || '<li class="muted small">No hay tareas visibles. Pulsa “＋ Tarea” y toca el plano.</li>'}</ul>`;
    listEl.querySelectorAll('[data-item]').forEach((li) =>
      li.addEventListener('click', () => {
        const t = ctx.tasks.find((x) => x.id === li.dataset.item);
        centerOn(t.x, t.y, Math.max(state.scale, fitScale() * 2.5));
        flash(t.id);
        openTaskDrawer(ctx, t.id);
      })
    );
    view.querySelector('.viewer-main').classList.toggle('list-open', state.listOpen);
  };
  const fitScale = () => {
    const r = canvas.getBoundingClientRect();
    return Math.min(r.width / W, r.height / H) * 0.95;
  };
  const flash = (id) => {
    const p = pinsEl.querySelector(`[data-pin="${id}"]`);
    if (!p) return;
    p.classList.remove('pin-flash');
    void p.offsetWidth;
    p.classList.add('pin-flash');
  };

  const setMode = (mode) => {
    if (mode !== state.mode) markupRef?.deselect();
    if (mode !== 'movephoto' && state.movePhotoId) {
      state.movePhotoId = null;
      pinsEl.querySelector('.pin-moving')?.classList.remove('pin-moving');
    }
    state.mode = mode;
    if (mode !== 'draw') markupRef?.clipCancel();
    canvas.classList.toggle('mode-add', mode === 'add' || mode === 'place' || mode === 'photo' || mode === 'movephoto');
    photoBtn.classList.toggle('btn-active', mode === 'photo');
    canvas.classList.toggle('mode-draw', mode === 'draw');
    markupBar.classList.toggle('hidden', mode !== 'draw');
    markupBtn.classList.toggle('btn-active', mode === 'draw');
    if (mode === 'draw') {
      markup.setVisible(true);
      if (window.innerWidth <= 900 && state.listOpen) {
        state.listOpen = false; // más espacio para dibujar en el móvil
        drawPins();
      }
      syncMarkupBar();
    }
    addBtn.classList.toggle('btn-active', mode === 'add');
    addBtn.title = mode === 'add' ? 'Cancelar' : 'Crear una tarea en el plano';
    view.querySelector('#view-rail').classList.toggle('hidden', mode === 'draw');
    closeFlyouts();
    if (mode === 'add') showHint('Toca el plano donde quieres crear la tarea');
    else if (mode === 'photo') showHint('Toca el punto del plano donde tomas la foto');
    else if (mode === 'place') {
      const t = ctx.tasks.find((x) => x.id === state.placeTaskId);
      showHint(`Toca el plano para ubicar la tarea #${t?.number ?? ''}`);
    } else if (mode === 'movephoto') showHint('Toca el nuevo punto de la foto o arrástrala', 'Cancelar');
    else showHint('');
  };
  const showHint = (text, action = '') => {
    hint.textContent = text;
    hint.classList.toggle('hint-action', !!action);
    if (action) {
      // Botón dentro del aviso (p. ej. cancelar el movimiento de una foto)
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.textContent = action;
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', () => setMode('view'));
      hint.append(' ', btn);
    }
    hint.classList.toggle('hidden', !text);
  };


  // Actualiza sólo los pines (y anotaciones) cuando cambia algo desde el panel lateral u otro usuario.
  ctx.onTaskChanged = async () => {
    await ctx.reload();
    await reloadPhotos();
    drawPins();
    await markup.load();
  };

  // ---------- Anotaciones ----------
  const markupBar = view.querySelector('#markup-bar');
  const lastOfGroup = {};
  function closeFlyouts() {
    view.querySelectorAll('.rail-group.open').forEach((g) => g.classList.remove('open'));
  }
  const markupBtn = view.querySelector('#markup-mode');
  const currentSheet = () => ctx.sheet(sheet.id) || sheet;
  const markup = createMarkupLayer({
    ctx, sheet, stage,
    getScale: () => state.scale,
    getCalibration: () => currentSheet().calibration,
    onCalibrate: (points) => calibrateDialog(points),
    onRecord: () => recordHist({ src: 'markup' }),
  });
  markupRef = markup;
  // Lupa al dibujar con el dedo (el dedo tapa el punto que se está pintando)
  const loupe = createLoupe({ img: stage.querySelector('img'), svg: stage.querySelector('svg.markups'), W, H, bounds: () => canvas.getBoundingClientRect(), getHires: () => stage.querySelector('canvas.hires') });
  let loupeOn = false;
  const showLoupe = (e) => {
    if (!loupeOn) return;
    const p = toPlan(e.clientX, e.clientY);
    loupe.show(e.clientX, e.clientY, p.x * W, p.y * H, state.scale);
  };
  const onLeaveLoupe = () => {
    if (!view.isConnected) {
      loupe.destroy();
      window.removeEventListener('hashchange', onLeaveLoupe);
    }
  };
  window.addEventListener('hashchange', onLeaveLoupe);
  const canTouchMarkups = () => canEdit(ctx.project.id) && markupsVisible && ['view', 'draw'].includes(state.mode);
  const drawTool = () => (state.mode === 'draw' ? markup.settings.tool : null);
  const selBar = view.querySelector('#sel-bar');
  selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
  markup.onSelectionChange((m) => {
    selBar.classList.toggle('hidden', !m);
    markupBar.classList.toggle('hidden', !!m || state.mode !== 'draw');
    if (m) {
      selBar.querySelectorAll('[data-sel-color]').forEach((b) => b.classList.toggle('active', b.dataset.selColor === m.color));
      showHint('Arrastra para mover · usa los círculos para cambiar el tamaño');
    } else if (state.mode === 'draw') syncMarkupBar();
    else showHint('');
  });
  selBar.querySelectorAll('[data-sel-color]').forEach((b) =>
    (b.onclick = async () => {
      await markup.recolorSelected(b.dataset.selColor);
      selBar.querySelectorAll('[data-sel-color]').forEach((x) => x.classList.toggle('active', x === b));
    })
  );
  view.querySelector('#sel-delete').onclick = async () => {
    await markup.deleteSelected();
    toast('Anotación eliminada');
  };
  view.querySelector('#sel-done').onclick = () => markup.deselect();
  function syncMarkupBar() {
    const s = markup.settings;
    markupBar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === s.tool));
    markupBar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === s.color));
    markupBar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === s.width));
    // Grupos de la barra: muestran la herramienta elegida (o la última usada del grupo)
    for (const [g, tools] of Object.entries(RAIL_GROUPS)) {
      if (tools.includes(s.tool)) lastOfGroup[g] = s.tool;
      const btn = markupBar.querySelector(`[data-group-btn="${g}"]`);
      btn.innerHTML = TOOL[lastOfGroup[g] || tools[0]].i;
      btn.classList.toggle('active', tools.includes(s.tool));
    }
    markupBar.querySelector('.color-dot').style.background = s.color;
    view.querySelector('#markup-undo').disabled = !hist.undo.length;
    view.querySelector('#markup-redo').disabled = !hist.redo.length;
    if (markup.selected()) return;
    canvas.dataset.tool = s.tool;
    const pending = markup.multiPending();
    const finishBtn = view.querySelector('#markup-finish');
    finishBtn.classList.toggle('hidden', !pending);
    finishBtn.textContent = `Terminar (${pending} ${pending === 1 ? 'punto' : 'puntos'})`;
    view.querySelectorAll('.clip-btn').forEach((b) => b.classList.toggle('hidden', s.tool !== 'clip'));
    if (s.tool === 'clip' && !markup.clipActive()) startClipWindow();
    if (s.tool !== 'clip') markup.clipCancel();
    updateScaleChip();
    const needsScale = ['measure', 'path', 'area'].includes(s.tool) && !currentSheet().calibration;
    const hints = {
      hand: 'Arrastra para mover el plano',
      text: 'Toca el plano donde quieres escribir',
      eraser: 'Toca o arrastra sobre una anotación para borrarla',
      measure: 'Arrastra de un punto a otro para medir',
      path: 'Toca cada punto del recorrido y pulsa Terminar',
      area: 'Toca los vértices; toca el primero (o Terminar) para cerrar',
      calibrate: 'Traza una línea sobre una cota conocida del plano',
      clip: 'Mueve y ajusta el recuadro sobre el resaltado; «Borrar dentro» quita lo que cubre',
    };
    if (needsScale) return showHint('Primero calibra la escala: pulsa «Sin escala» o usa la herramienta Calibrar');
    showHint(hints[s.tool] || 'Dibuja con un dedo · usa dos dedos para mover y hacer zoom');
  }
  markupBar.addEventListener('pointerdown', (e) => e.stopPropagation());
  markupBar.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = async () => {
    await markup.finishMulti();
    markup.setTool(b.dataset.tool);
    closeFlyouts();
    syncMarkupBar();
  }));
  // Grupos: el primer toque elige la última herramienta usada del grupo y abre las demás a la izquierda
  markupBar.querySelectorAll('[data-group-btn]').forEach((b) => (b.onclick = async () => {
    const g = b.dataset.groupBtn;
    const wrap = b.closest('.rail-group');
    const wasOpen = wrap.classList.contains('open');
    closeFlyouts();
    if (RAIL_GROUPS[g] && !RAIL_GROUPS[g].includes(markup.settings.tool)) {
      await markup.finishMulti();
      markup.setTool(lastOfGroup[g] || RAIL_GROUPS[g][0]);
      syncMarkupBar();
    }
    if (!wasOpen) wrap.classList.add('open');
  }));
  markupBar.querySelectorAll('[data-color], [data-width]').forEach((b) => b.addEventListener('click', closeFlyouts));
  view.querySelector('#markup-finish').onclick = async () => { await markup.finishMulti(); syncMarkupBar(); };
  /** Recuadro de recorte inicial: en el centro de la zona visible del plano. */
  function startClipWindow() {
    const r = canvas.getBoundingClientRect();
    const a = toPlan(r.left + r.width * 0.25, r.top + r.height * 0.3), b = toPlan(r.left + r.width * 0.75, r.top + r.height * 0.6);
    const c = (v) => Math.min(1, Math.max(0, v));
    markup.clipStart([c(a.x), c(a.y), c(b.x), c(b.y)]);
  }
  const applyClip = async (mode) => {
    const n = await markup.clipApply(mode);
    toast(n ? `${n} anotación(es) recortada(s) · puedes deshacerlo con ↶` : 'El recuadro no toca ninguna anotación que se pueda recortar (resaltados, líneas o formas)', n ? undefined : 'error');
    syncMarkupBar();
  };
  // En algunos Android el primer clic tras arrastrar el recuadro se pierde: también al levantar el dedo
  const onTap = (btn, fn) => {
    let down = false;
    let lastUp = -Infinity;
    btn.addEventListener('pointerdown', () => (down = true));
    btn.addEventListener('pointerleave', () => (down = false));
    btn.addEventListener('pointerup', () => {
      if (down) {
        lastUp = performance.now();
        fn();
      }
      down = false;
    });
    btn.addEventListener('click', () => {
      if (performance.now() - lastUp > 700) fn();
    });
  };
  onTap(view.querySelector('#clip-cut'), () => applyClip('cut'));
  onTap(view.querySelector('#clip-keep'), () => applyClip('keep'));
  view.querySelector('#scale-chip').onclick = () => calibrateDialog(null);

  // ---------- Escala / calibración ----------
  const nfScale = new Intl.NumberFormat('es', { maximumFractionDigits: 2 });
  function updateScaleChip() {
    const c = currentSheet().calibration;
    const chip = view.querySelector('#scale-chip');
    chip.classList.toggle('scale-set', !!c);
    chip.textContent = !c ? 'Sin escala' : c.method === 'scale' ? `Escala 1:${nfScale.format(c.scale)}` : 'Escala calibrada';
  }
  async function saveCalibration(calibration) {
    const fresh = (await db.get('sheets', sheet.id)) || currentSheet();
    if (calibration) fresh.calibration = calibration;
    else delete fresh.calibration;
    await db.put('sheets', fresh);
    await ctx.reload();
    markup.render();
    syncMarkupBar();
  }
  async function calibrateDialog(points) {
    const c = currentSheet().calibration;
    const paperMm = await pdfPageWidthMm(currentSheet());
    const pxLen = points ? Math.hypot((points[1][0] - points[0][0]) * W, (points[1][1] - points[0][1]) * H) : 0;
    if (points && pxLen * state.scale < 10) return toast('Traza una línea más larga sobre la cota', 'error');
    const { el } = modal({
      title: 'Escala del plano',
      body: points
        ? `<p class="muted small">¿Cuánto mide en la realidad la línea que has trazado?</p>
           <div class="row2">
             <label class="field"><span>Medida real *</span><input id="cal-len" name="len" inputmode="decimal" required placeholder="Ej. 8,50" /></label>
             <label class="field"><span>Unidad</span><select id="cal-unit" name="unit"><option value="1">m</option><option value="0.01">cm</option><option value="0.001">mm</option></select></label>
           </div>`
        : `${paperMm ? `
           <label class="field"><span>Escala del plano (1:N)</span>
             <input id="cal-scale" name="scale" inputmode="decimal" placeholder="Ej. 100" value="${c?.method === 'scale' ? c.scale : ''}" /></label>
           <p class="muted small">Tamaño del papel: ${nfScale.format(paperMm)} mm de ancho. Usa la escala de impresión que indica el cajetín del plano.</p>
           <p class="muted small">¿No conoces la escala? Usa la herramienta <strong>Calibrar</strong> y traza una línea sobre una cota del plano.</p>`
          : `<p>Para medir, primero indica una medida conocida del plano.</p>
             <p class="muted small">Elige la herramienta <strong>Calibrar</strong> en la barra y traza una línea sobre una cota (por ejemplo, una distancia entre ejes); después escribe cuánto mide en la realidad.</p>`}
           ${c ? '<hr /><button type="button" class="btn btn-sm" id="cal-clear">Quitar calibración</button>' : ''}`,
      submitLabel: points || paperMm ? 'Guardar escala' : 'Entendido',
      onSubmit: async (v) => {
        const num = (x) => Number(String(x || '').replace(/\s/g, '').replace(',', '.'));
        if (points) {
          const meters = num(v.len) * Number(v.unit);
          if (!(meters > 0)) return toast('Escribe una medida válida', 'error'), false;
          await saveCalibration({ method: 'line', metersPerWidth: (meters * W) / pxLen, reference: `${v.len} ${({ 1: 'm', 0.01: 'cm', 0.001: 'mm' })[v.unit]}`, by: userName(), at: Date.now() });
          toast('Escala calibrada');
        } else if (paperMm) {
          const n = num(v.scale);
          if (!(n > 0)) return toast('Escribe la escala, por ejemplo 100 para 1:100', 'error'), false;
          await saveCalibration({ method: 'scale', scale: n, metersPerWidth: (paperMm * n) / 1000, by: userName(), at: Date.now() });
          toast(`Escala 1:${nfScale.format(n)} guardada`);
        }
      },
    });
    el.querySelector('#cal-clear')?.addEventListener('click', async () => {
      await saveCalibration(null);
      el.remove();
      toast('Calibración eliminada');
    });
    if (points) markup.setTool(markup.settings.tool === 'calibrate' ? 'measure' : markup.settings.tool);
  }
  markupBar.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => { markup.setColor(b.dataset.color); syncMarkupBar(); }));
  markupBar.querySelectorAll('[data-width]').forEach((b) => (b.onclick = () => { markup.setWidth(Number(b.dataset.width)); syncMarkupBar(); }));
  view.querySelector('#markup-undo').onclick = () => undoHist();
  view.querySelector('#markup-redo').onclick = () => redoHist();
  view.querySelector('#hist-undo').onclick = () => undoHist();
  view.querySelector('#hist-redo').onclick = () => redoHist();
  view.querySelector('#markup-done').onclick = async () => {
    await markup.finishMulti();
    markup.deselect();
    setMode('view');
  };
  markupBtn.onclick = () => setMode(state.mode === 'draw' ? 'view' : 'draw');
  let markupsVisible = true;
  try { markupsVisible = localStorage.getItem('obraplan.markupsVisible') !== '0'; } catch { /* sin almacenamiento */ }
  const visBtn = view.querySelector('#markup-visible');
  const applyVisible = () => {
    markup.setVisible(markupsVisible);
    visBtn.setAttribute('aria-pressed', String(markupsVisible));
    visBtn.classList.toggle('off', !markupsVisible);
    visBtn.classList.toggle('active', markupsVisible);
    visBtn.title = markupsVisible ? 'Ocultar anotaciones' : 'Mostrar anotaciones';
  };
  visBtn.onclick = () => {
    markupsVisible = !markupsVisible;
    if (!markupsVisible) markup.deselect();
    if (!markupsVisible && state.mode === 'draw') setMode('view');
    try { localStorage.setItem('obraplan.markupsVisible', markupsVisible ? '1' : '0'); } catch { /* sin almacenamiento */ }
    applyVisible();
  };

  // ---------- Interacción ----------
  const pointers = new Map();
  let gesture = null;
  let longPress = null;
  let pressStart = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    loupeOn = e.pointerType !== 'mouse' && pointers.size === 1;
    if (pointers.size > 1) loupe.hide();
    clearTimeout(longPress);
    if (pointers.size === 2 && gesture?.type === 'edit') markup.endEdit();

    // Con una anotación seleccionada: arrastrar un tirador la redimensiona, arrastrarla la mueve
    if (pointers.size === 1 && markup.selected()) {
      const p = toPlan(e.clientX, e.clientY);
      const part = markup.pickSelection(p);
      if (part) {
        markup.beginEdit(part, p);
        gesture = { type: 'edit' };
        return;
      }
      markup.deselect();
    }
    const tool = drawTool();
    const photoPinEl = state.mode === 'view' && pointers.size === 1 ? e.target.closest('[data-photo-pin]') : null;
    // Pulsación larga sobre una foto del plano: menú para verla, moverla o eliminarla
    if (photoPinEl && canEdit(ctx.project.id)) {
      const start = { x: e.clientX, y: e.clientY };
      pressStart = start;
      longPress = setTimeout(() => {
        if (pointers.size !== 1 || !gesture || gesture.moved || gesture.type !== 'pan') return;
        gesture.handled = true; // al levantar el dedo no se abre el visor
        navigator.vibrate?.(15);
        const doc = photoPins.find((x) => x.id === photoPinEl.dataset.photoPin);
        if (doc) openPhotoMenu(doc);
      }, LONG_PRESS_MS);
    }
    // Pulsación larga sobre una anotación: seleccionarla
    else if (pointers.size === 1 && canTouchMarkups() && tool !== 'eraser' && tool !== 'clip') {
      const start = { x: e.clientX, y: e.clientY };
      pressStart = start;
      longPress = setTimeout(() => {
        if (pointers.size !== 1 || !gesture || gesture.moved || !['pan', 'draw'].includes(gesture.type)) return;
        const p = toPlan(start.x, start.y);
        const item = markup.hitTest(p);
        if (!item) return;
        if (gesture.type === 'draw') markup.cancel();
        markup.select(item);
        markup.beginEdit('move', p);
        gesture = { type: 'edit' };
        navigator.vibrate?.(15);
      }, LONG_PRESS_MS);
    }
    if (tool === 'clip') {
      // Herramienta de recorte: se arrastra el recuadro o sus tiradores; fuera de él, se mueve el plano
      const part = pointers.size === 1 ? markup.clipPick(toPlan(e.clientX, e.clientY)) : null;
      if (part) {
        markup.clipBegin(part, toPlan(e.clientX, e.clientY));
        gesture = { type: 'clipwin' };
        return;
      }
    } else if (pointers.size === 1 && tool && !['hand', 'text', 'path', 'area'].includes(tool)) {
      const p = toPlan(e.clientX, e.clientY);
      if (tool === 'eraser') {
        gesture = { type: 'erase' };
        markup.eraseAt(p).then(syncMarkupBar);
      } else if (markup.start(p)) {
        gesture = { type: 'draw' };
        showLoupe(e);
      }
      return;
    }
    if (pointers.size === 2 && gesture?.type === 'draw') markup.cancel();
    if (pointers.size === 1) {
      const pin = e.target.closest('[data-pin], [data-photo-pin]');
      gesture = { type: 'pan', startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, pinId: pin?.dataset.pin, photoId: pin?.dataset.photoPin, pinEl: pin, t0: Date.now() };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > TAP_TOLERANCE) {
      clearTimeout(longPress);
      pressStart = null;
    }
    if (gesture.type === 'clipwin') return markup.clipDrag(toPlan(e.clientX, e.clientY));
    if (gesture.type === 'edit') {
      showLoupe(e);
      return markup.editTo(toPlan(e.clientX, e.clientY));
    }
    if (gesture.type === 'draw') {
      if (pointers.size === 1) showLoupe(e);
      return markup.move(toPlan(e.clientX, e.clientY));
    }
    if (gesture.type === 'erase') return void markup.eraseAt(toPlan(e.clientX, e.clientY)).then(syncMarkupBar);
    if (gesture.type === 'pan') {
      if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > TAP_TOLERANCE) gesture.moved = true;
      if (!gesture.moved) return;
      // Pines de tareas: se arrastran directamente. Fotos: solo la que se está moviendo (desde su menú)
      const draggable = (gesture.pinId && state.mode === 'view') || (gesture.photoId && state.mode === 'movephoto' && gesture.photoId === state.movePhotoId);
      if (draggable && canEdit(ctx.project.id)) {
        // Arrastrar un pin para reubicar la tarea
        const p = toPlan(e.clientX, e.clientY);
        gesture.pinEl.style.left = `${Math.min(1, Math.max(0, p.x)) * W}px`;
        gesture.pinEl.style.top = `${Math.min(1, Math.max(0, p.y)) * H}px`;
        gesture.pinEl.classList.add('pin-dragging');
        gesture.dragging = true;
      } else {
        state.tx += e.clientX - gesture.lastX;
        state.ty += e.clientY - gesture.lastY;
        apply();
      }
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
    } else if (gesture.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = canvas.getBoundingClientRect();
      state.tx += mid.x - gesture.mid.x;
      state.ty += mid.y - gesture.mid.y;
      zoomAt(dist / gesture.dist, mid.x - r.left, mid.y - r.top);
      gesture.dist = dist;
      gesture.mid = mid;
    }
  });

  const endPointer = async (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    loupe.hide();
    clearTimeout(longPress);
    pressStart = null;
    const g = gesture;
    if (g?.type === 'clipwin') {
      markup.clipEnd();
      gesture = null;
      return;
    }
    if (g?.type === 'edit') {
      gesture = pointers.size ? { type: 'pan', startX: 0, startY: 0, lastX: [...pointers.values()][0].x, lastY: [...pointers.values()][0].y, moved: true } : null;
      await markup.endEdit();
      return syncMarkupBar();
    }
    if (pointers.size > 0) {
      // Al levantar un dedo del pellizco, continuar paneando con el otro
      const [p] = [...pointers.values()];
      gesture = { type: 'pan', startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: true };
      return;
    }
    gesture = null;
    if (g?.type === 'draw') {
      if (e.type === 'pointercancel') markup.cancel();
      else await markup.end();
      return syncMarkupBar();
    }
    if (g?.type === 'erase') return;
    if (!g || e.type === 'pointercancel') return;

    if (g.handled) return; // la pulsación larga ya abrió el menú
    if (g.dragging && g.photoId) return movePhotoTo(g.photoId, toPlan(e.clientX, e.clientY));
    if (g.dragging) {
      const task = ctx.tasks.find((t) => t.id === g.pinId);
      const p = toPlan(e.clientX, e.clientY);
      recordHist({ src: 'task', taskId: task.id, before: { x: task.x, y: task.y }, after: { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) } });
      task.x = Math.min(1, Math.max(0, p.x));
      task.y = Math.min(1, Math.max(0, p.y));
      await saveTask(task, 'Reubicada en el plano', userName());
      toast(`Tarea #${task.number} reubicada`);
      drawPins();
      return;
    }
    if (g.moved) return;

    // Toque (tap)
    const p = toPlan(e.clientX, e.clientY);
    if (state.mode === 'draw') {
      if (['path', 'area'].includes(markup.settings.tool)) {
        if (!inside(p)) return toast('Toca dentro del plano', 'error');
        await markup.addVertex(p);
        return syncMarkupBar();
      }
      if (markup.settings.tool === 'text') {
        if (!inside(p)) return toast('Toca dentro del plano', 'error');
        markup.addText(p);
        setTimeout(syncMarkupBar, 400);
      }
      return;
    }
    if (state.mode === 'photo') {
      if (!inside(p)) return toast('Toca dentro del plano', 'error');
      setMode('view');
      const saved = await addPhotoPin(ctx, sheet, p);
      if (saved) {
        recordPhoto(saved.id, null, saved);
        await reloadPhotos();
        drawPins();
      }
      return;
    }
    if (state.mode === 'movephoto') {
      if (!inside(p)) return toast('Toca dentro del plano', 'error');
      return movePhotoTo(state.movePhotoId, p);
    }
    if (state.mode === 'view' && g.photoId) {
      const doc = photoPins.find((x) => x.id === g.photoId);
      if (doc) showPhotos(doc);
      return;
    }
    if (state.mode === 'add') {
      if (!inside(p)) return toast('Toca dentro del plano', 'error');
      setMode('view');
      await newTaskForm(ctx, { sheetId: sheet.id, x: p.x, y: p.y });
    } else if (state.mode === 'place') {
      if (!inside(p)) return toast('Toca dentro del plano', 'error');
      const task = await db.get('tasks', state.placeTaskId);
      if (task) {
        task.sheetId = sheet.id;
        task.x = p.x;
        task.y = p.y;
        await saveTask(task, `Ubicada en el plano ${sheet.name}`, userName());
        toast(`Tarea #${task.number} ubicada`);
      }
      state.placeTaskId = null;
      history.replaceState(null, '', `#/p/${ctx.project.id}/plans/${sheet.id}`);
      setMode('view');
      await ctx.reload();
      drawPins();
      if (task) openTaskDrawer(ctx, task.id);
    } else if (g.pinId) {
      openTaskDrawer(ctx, g.pinId);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  view.querySelector('#zoom-in').onclick = () => zoomCenter(1.4);
  view.querySelector('#zoom-out').onclick = () => zoomCenter(1 / 1.4);
  view.querySelector('#zoom-fit').onclick = fit;
  view.querySelector('#export-pdf').onclick = () => openExportDialog(ctx, [currentSheet()]);
  // Ventanas de la barra superior: capas/filtros (ojo) y menú (⋮)
  const toolbar = view.querySelector('.viewer-toolbar');
  const setPop = (cls) => {
    for (const [c, id] of [['show-filters', '#filters-toggle'], ['show-menu', '#viewer-more']]) {
      const on = c === cls && !toolbar.classList.contains(c);
      toolbar.classList.toggle(c, on);
      view.querySelector(id).setAttribute('aria-expanded', String(on));
    }
  };
  view.querySelector('#filters-toggle').onclick = () => setPop('show-filters');
  view.querySelector('#viewer-more').onclick = () => setPop('show-menu');
  view.querySelector('#viewer-menu').addEventListener('click', (e) => e.target.closest('button') && setPop(null));
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tool-rail, .markup-ctx, .markup-bar, .version-chip, .compare-bar, .viewer-hint')) return;
    setPop(null);
    closeFlyouts();
  }, true);
  // Barra lateral: se puede plegar para ver más plano (se recuerda en este dispositivo)
  const viewRail = view.querySelector('#view-rail');
  const railToggle = view.querySelector('#rail-toggle');
  const setRailCollapsed = (c) => {
    viewRail.classList.toggle('collapsed', c);
    railToggle.innerHTML = icon(c ? 'chevronUp' : 'chevronDown');
    railToggle.setAttribute('aria-expanded', String(!c));
    railToggle.title = c ? 'Mostrar las herramientas' : 'Plegar la barra';
    try { localStorage.setItem('obraplan.railCollapsed', c ? '1' : '0'); } catch { /* sin almacenamiento */ }
  };
  try { if (localStorage.getItem('obraplan.railCollapsed') === '1') setRailCollapsed(true); } catch { /* sin almacenamiento */ }
  railToggle.onclick = () => setRailCollapsed(!viewRail.classList.contains('collapsed'));
  for (const el of [viewRail, view.querySelector('#version-chip')]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  view.querySelector('#toggle-list').onclick = () => {
    state.listOpen = !state.listOpen;
    drawPins();
  };
  addBtn.onclick = () => setMode(state.mode === 'add' ? 'view' : 'add');
  photoBtn.onclick = () => setMode(state.mode === 'photo' ? 'view' : 'photo');
  view.querySelector('#filter-photos').onclick = (e) => {
    state.photosVisible = !state.photosVisible;
    e.currentTarget.classList.toggle('active', state.photosVisible);
    drawPins();
  };
  // ---------- Deshacer / rehacer en el plano ----------
  // Historial común de la pantalla: anotaciones (las lleva markup.js, aquí solo su turno), fotos del plano
  // (añadir, mover, borrar, quitar o añadir fotos a un punto) y pines de tareas movidos.
  // Las fotos borradas no se eliminan del todo hasta salir del plano, para poder recuperarlas.
  const hist = { undo: [], redo: [] };
  const pinRefs = new Map(); // id de un punto de fotos -> { id } actual (al recuperarlo cambia de id)
  const refOf = (id) => {
    if (!pinRefs.has(id)) pinRefs.set(id, { id });
    return pinRefs.get(id);
  };
  const strip = (d) => {
    if (!d) return null;
    const { id, _rev, ...rest } = structuredClone(d);
    return rest;
  };
  function syncHistButtons() {
    view.querySelector('#hist-undo').disabled = !hist.undo.length;
    view.querySelector('#hist-redo').disabled = !hist.redo.length;
    if (state.mode === 'draw') {
      view.querySelector('#markup-undo').disabled = !hist.undo.length;
      view.querySelector('#markup-redo').disabled = !hist.redo.length;
    }
  }
  function recordHist(entry) {
    hist.undo.push(entry);
    if (hist.undo.length > 100) hist.undo.shift();
    hist.redo.length = 0;
    if (entry.src !== 'markup') markup.clearRedo();
    syncHistButtons();
  }
  function recordPhoto(id, before, after) {
    const ref = refOf(id);
    if (after?.id && after.id !== id) pinRefs.set(after.id, ref);
    recordHist({ src: 'photo', ref, before: strip(before), after: strip(after) });
  }
  /** Deja un punto de fotos como `data` (o lo quita si es null). */
  async function setPhotoPin(ref, data) {
    const existing = await db.get('markups', ref.id);
    if (!data) {
      if (existing) await db.del('markups', ref.id);
      return;
    }
    if (!existing) {
      // Un documento borrado no se puede recuperar con el mismo id (sincronización): se crea de nuevo
      ref.id = uid();
      pinRefs.set(ref.id, ref);
    }
    await db.put('markups', { ...structuredClone(data), id: ref.id });
  }
  async function applyHist(entry, dir) {
    if (entry.src === 'markup') return dir === 'undo' ? markup.undo() : markup.redo();
    const target = dir === 'undo' ? entry.before : entry.after;
    if (entry.src === 'photo') {
      await setPhotoPin(entry.ref, target);
      // Las fotos que dejen de usarse se eliminarán al salir del plano (si no se rehace)
      deferPurge([...(entry.before?.photoIds || []), ...(entry.after?.photoIds || [])]);
      await reloadPhotos();
    } else if (entry.src === 'task') {
      const task = await db.get('tasks', entry.taskId);
      if (task) {
        Object.assign(task, target);
        await saveTask(task, dir === 'undo' ? 'Reubicación deshecha' : 'Reubicada en el plano', userName());
        await ctx.reload();
      }
    }
  }
  const histLabel = (e) => ({ markup: 'anotación', photo: 'foto', task: 'tarea' }[e.src]);
  let histBusy = false;
  async function undoHist() {
    const e = hist.undo.pop();
    if (!e || histBusy) return e && hist.undo.push(e);
    histBusy = true;
    try {
      await applyHist(e, 'undo');
      hist.redo.push(e);
      toast(`Deshecho (${histLabel(e)})`);
    } finally {
      histBusy = false;
    }
    drawPins();
    syncHistButtons();
    if (state.mode === 'draw') syncMarkupBar();
  }
  async function redoHist() {
    const e = hist.redo.pop();
    if (!e || histBusy) return e && hist.redo.push(e);
    histBusy = true;
    try {
      await applyHist(e, 'redo');
      hist.undo.push(e);
      toast(`Rehecho (${histLabel(e)})`);
    } finally {
      histBusy = false;
    }
    drawPins();
    syncHistButtons();
    if (state.mode === 'draw') syncMarkupBar();
  }
  // Archivos de fotos borradas: se eliminan al salir del plano si ningún punto de fotos los usa
  const pendingPurge = new Set();
  const deferPurge = (ids) => ids.forEach((id) => pendingPurge.add(id));
  async function purgeDeleted() {
    if (!pendingPurge.size) return;
    const ids = [...pendingPurge];
    pendingPurge.clear();
    const used = new Set((await db.byProject('markups', ctx.project.id)).filter((m) => m.type === 'photo').flatMap((m) => m.photoIds || []));
    await purgePhotoFiles(ctx, ids.filter((id) => !used.has(id)));
  }
  const viewerHash = location.hash.split('?')[0];
  const onLeave = () => {
    if (location.hash.split('?')[0] === viewerHash) return;
    window.removeEventListener('hashchange', onLeave);
    purgeDeleted();
  };
  window.addEventListener('hashchange', onLeave);
  window.addEventListener('pagehide', () => purgeDeleted(), { once: true });

  async function movePhotoTo(id, p) {
    const doc = photoPins.find((x) => x.id === id);
    setMode('view');
    if (!doc) return drawPins();
    const before = structuredClone(doc);
    doc.points = [[Math.min(1, Math.max(0, p.x)), Math.min(1, Math.max(0, p.y))]];
    await db.put('markups', doc);
    recordPhoto(doc.id, before, doc);
    toast('Foto movida');
    drawPins();
  }

  function openPhotoMenu(doc) {
    photoPinMenu(doc, {
      view: () => showPhotos(doc),
      move: () => {
        setMode('movephoto');
        state.movePhotoId = doc.id;
        drawPins();
      },
      remove: async () => {
        const before = structuredClone(doc);
        if (await deletePhotoPin(ctx, doc, { keepFiles: true })) {
          recordPhoto(doc.id, before, null);
          deferPurge(before.photoIds);
          await reloadPhotos();
          drawPins();
        }
      },
    });
  }

  function showPhotos(doc) {
    openPhotoViewer(ctx, doc, {
      canEdit: canEdit(ctx.project.id),
      record: (before, after) => recordPhoto(doc.id, before, after),
      deferFiles: (ids) => deferPurge(ids),
      onChange: async () => {
        await reloadPhotos();
        drawPins();
      },
      onCreateTask: async (pin, copies) => {
        // La tarea se coloca junto al icono de fotos (no debajo), a ~30 px en pantalla
        const dx = 30 / state.scale / W;
        const x = Math.min(1, pin.points[0][0] + dx);
        const task = await newTaskForm(ctx, { sheetId: sheet.id, x, y: pin.points[0][1], photoIds: copies });
        if (!task) for (const id of copies) await deleteFile(id); // cancelada: no dejar copias sueltas
      },
    });
  }
  view.querySelector('#sheet-switch').onchange = (e) => (location.hash = `#/p/${ctx.project.id}/plans/${e.target.value}`);
  view.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.filter;
      if (state.hidden.has(id)) state.hidden.delete(id);
      else state.hidden.add(id);
      b.classList.toggle('active', !state.hidden.has(id));
      drawPins();
    })
  );

  // Mantener el centro visible cuando cambia el tamaño del lienzo (rotación, lista lateral...).
  let lastSize = null;
  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (lastSize && width && height) {
      state.tx += (width - lastSize.width) / 2;
      state.ty += (height - lastSize.height) / 2;
      apply();
    }
    lastSize = { width, height };
  }).observe(canvas);

  // Redibujado nítido desde el PDF original al hacer zoom
  pdfLayer = createPdfLayer({ sheet, stage, container: canvas, getState: () => state });

  // ---------- Comparar versiones ----------
  const compareBar = view.querySelector('#compare-bar');
  const compare = createCompare({ sheet, stage, container: canvas, getState: () => state });
  compareRef = compare;
  let compareMode = 'overlay';
  async function openCompare(versionNumber) {
    const v = versions.find((x) => x.version === Number(versionNumber)) || versions[0];
    if (!v || !compareBar) return;
    if (state.mode !== 'view') setMode('view');
    markup.deselect();
    compareBar.classList.remove('hidden');
    compareBar.querySelector('#compare-version').value = v.version;
    compareBar.querySelectorAll('[data-cmode]').forEach((b) => b.classList.toggle('active', b.dataset.cmode === compareMode));
    compareBar.querySelector('#compare-legend').classList.toggle('hidden', compareMode !== 'overlay');
    view.querySelector('#compare-btn')?.classList.add('btn-active');
    stage.classList.add('comparing');
    markup.setVisible(false);
    // En la cortina la versión actual sigue redibujándose nítida; en la superposición la sustituye la diferencia
    pdfLayer.setEnabled(compareMode !== 'overlay');
    showHint(compareMode === 'overlay' ? 'Preparando la comparación...' : '');
    try {
      await compare.show(v, compareMode);
      if (compare.aspectMismatch(v) > 0.015) toast('Las versiones tienen distinto tamaño de hoja: la comparación puede no coincidir exactamente', 'error');
      showHint(compareMode === 'curtain' ? 'Arrastra la cortina ⇔ para ver una versión u otra' : '');
    } catch (err) {
      toast(err.message || 'No se pudo comparar', 'error');
      closeCompare();
    }
  }
  function closeCompare() {
    if (!compareBar) return;
    compare.close();
    compareBar.classList.add('hidden');
    view.querySelector('#compare-btn')?.classList.remove('btn-active');
    stage.classList.remove('comparing');
    applyVisible();
    pdfLayer.setEnabled(true);
    showHint('');
  }
  if (compareBar) {
    view.querySelector('#compare-btn').onclick = () => (compare.active() ? closeCompare() : openCompare(versions[0].version));
    view.querySelector('#version-chip').onclick = () => (compare.active() ? closeCompare() : openCompare(versions[0].version));
    compareBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    compareBar.querySelector('#compare-version').onchange = (e) => openCompare(e.target.value);
    compareBar.querySelectorAll('[data-cmode]').forEach((b) =>
      (b.onclick = () => {
        compareMode = b.dataset.cmode;
        openCompare(compareBar.querySelector('#compare-version').value);
      })
    );
    compareBar.querySelector('#compare-close').onclick = closeCompare;
  }
  const leaveCompare = () => compare.active() && closeCompare();
  markupBtn.addEventListener('click', leaveCompare, true);
  addBtn.addEventListener('click', leaveCompare, true);
  photoBtn.addEventListener('click', leaveCompare, true);

  // ---------- Estado inicial ----------
  await reloadPhotos();
  drawPins();
  applyVisible();
  await markup.load();
  await new Promise((r) => requestAnimationFrame(r));
  fit();
  setMode(state.mode);
  if (params.get('compare')) openCompare(params.get('compare'));
  const focusId = params.get('task');
  const focus = focusId && ctx.tasks.find((t) => t.id === focusId && t.sheetId === sheet.id && t.x != null);
  if (focus) {
    centerOn(focus.x, focus.y, fitScale() * 2.5);
    flash(focus.id);
    openTaskDrawer(ctx, focus.id);
  }
}

/** Opciones del selector de planos, agrupadas por carpeta. */
function sheetOptions(ctx, selectedId) {
  const groups = new Map();
  for (const s of ctx.sheets) {
    const f = normPath(s.folder);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(s);
  }
  const opt = (s) => `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)}</option>`;
  if (groups.size === 1 && groups.has('')) return ctx.sheets.map(opt).join('');
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true }))
    .map(([f, list]) => `<optgroup label="${esc(prettyPath(f))}">${list.map(opt).join('')}</optgroup>`)
    .join('');
}
