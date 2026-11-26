import { db, STATUSES, statusOf, saveTask, fileUrl, isOverdue } from '../db.js';
import { esc, toast, avatar, fmtDate, userName } from '../ui.js';
import { openTaskDrawer, newTaskForm } from './taskDetail.js';
import { canEdit } from '../sync.js';
import { createPdfLayer } from '../hires.js';
import { createMarkupLayer, MARKUP_TOOLS, MARKUP_COLORS, MARKUP_WIDTHS } from '../markup.js';

const MIN_SCALE = 0.05;
const TAP_TOLERANCE = 6;
const LONG_PRESS_MS = 450;

export async function renderViewer(view, ctx, sheetId, params) {
  const sheet = ctx.sheet(sheetId);
  if (!sheet) {
    view.innerHTML = `<div class="empty"><h2>Plano no encontrado</h2><a class="btn" href="#/p/${ctx.project.id}/plans">Volver a planos</a></div>`;
    return;
  }
  const src = await fileUrl(sheet.fileId);
  const W = sheet.width, H = sheet.height;
  // Zoom máximo (píxeles de pantalla por píxel de la imagen base). En PDF se redibuja en vectorial,
  // así que se puede ampliar mucho más sin perder nitidez.
  const MAX_SCALE = sheet.pdfFileId ? 16 : 6;

  const state = {
    scale: 1, tx: 0, ty: 0,
    mode: params.get('place') ? 'place' : 'view',
    placeTaskId: params.get('place') || null,
    hidden: new Set(),
    listOpen: window.innerWidth > 900,
  };

  view.innerHTML = `
    <div class="viewer">
      <div class="viewer-toolbar">
        <a class="icon-btn" href="#/p/${ctx.project.id}/plans" title="Volver a planos" aria-label="Volver">←</a>
        <select id="sheet-switch" class="sheet-switch" aria-label="Cambiar de plano">
          ${ctx.sheets.map((s) => `<option value="${s.id}" ${s.id === sheet.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <div class="status-filters" role="group" aria-label="Filtrar por estado">
          ${STATUSES.map((s) => `<button class="chip active" data-filter="${s.id}" style="--c:${s.color}" title="${s.label}">${s.short}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <button class="btn write" id="markup-mode" title="Dibujar y escribir sobre el plano">✎ Anotar</button>
        <button class="icon-btn" id="markup-visible" title="Ocultar anotaciones" aria-label="Mostrar u ocultar anotaciones" aria-pressed="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="btn btn-primary write" id="add-mode">＋ Tarea</button>
        <div class="zoom-group">
          <button class="icon-btn" id="zoom-out" aria-label="Alejar">−</button>
          <button class="icon-btn" id="zoom-fit" aria-label="Ajustar" title="Ajustar a pantalla">⤢</button>
          <button class="icon-btn" id="zoom-in" aria-label="Acercar">＋</button>
        </div>
        <button class="icon-btn" id="toggle-list" title="Lista de tareas" aria-label="Lista de tareas">☰</button>
      </div>
      <div class="viewer-main">
        <div class="viewer-canvas" id="canvas">
          <div class="stage" id="stage" style="width:${W}px;height:${H}px">
            <img src="${src}" alt="${esc(sheet.name)}" draggable="false" />
            <div class="pins" id="pins"></div>
          </div>
          <div class="viewer-hint hidden" id="hint"></div>
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
          <div class="markup-bar hidden" id="markup-bar" role="toolbar" aria-label="Herramientas de anotación">
            <div class="markup-group">
              ${MARKUP_TOOLS.map((t) => `<button class="markup-tool" data-tool="${t.id}" title="${t.n}" aria-label="${t.n}">${t.i}</button>`).join('')}
            </div>
            <div class="markup-group">
              ${MARKUP_COLORS.map((c) => `<button class="markup-color" data-color="${c.c}" style="--mc:${c.c}" title="${c.n}" aria-label="Color ${c.n}"></button>`).join('')}
            </div>
            <div class="markup-group">
              ${MARKUP_WIDTHS.map((w) => `<button class="markup-width" data-width="${w.w}" title="${w.n}" aria-label="Grosor ${w.n}"><span style="height:${w.w + 1}px"></span></button>`).join('')}
            </div>
            <div class="markup-group">
              <button class="markup-tool" id="markup-undo" title="Deshacer" aria-label="Deshacer"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
              <button class="btn btn-primary btn-sm" id="markup-done">Listo</button>
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

  const sheetTasks = () => ctx.tasks.filter((t) => t.sheetId === sheet.id && t.x != null);

  // ---------- Transformación ----------
  let pdfLayer = null;
  let markupRef = null;
  const apply = () => {
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    pdfLayer?.schedule();
    stage.style.setProperty('--inv', 1 / state.scale);
    markupRef?.refreshSelection();
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
      .join('');
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
    state.mode = mode;
    canvas.classList.toggle('mode-add', mode === 'add' || mode === 'place');
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
    addBtn.textContent = mode === 'add' ? 'Cancelar' : '＋ Tarea';
    if (mode === 'add') showHint('Toca el plano donde quieres crear la tarea');
    else if (mode === 'place') {
      const t = ctx.tasks.find((x) => x.id === state.placeTaskId);
      showHint(`Toca el plano para ubicar la tarea #${t?.number ?? ''}`);
    } else showHint('');
  };
  const showHint = (text) => {
    hint.textContent = text;
    hint.classList.toggle('hidden', !text);
  };

  // Actualiza sólo los pines (y anotaciones) cuando cambia algo desde el panel lateral u otro usuario.
  ctx.onTaskChanged = async () => {
    await ctx.reload();
    drawPins();
    await markup.load();
  };

  // ---------- Anotaciones ----------
  const markupBar = view.querySelector('#markup-bar');
  const markupBtn = view.querySelector('#markup-mode');
  const markup = createMarkupLayer({ ctx, sheet, stage, getScale: () => state.scale });
  markupRef = markup;
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
    view.querySelector('#markup-undo').disabled = !markup.canUndo();
    if (markup.selected()) return;
    canvas.dataset.tool = s.tool;
    const hints = { hand: 'Arrastra para mover el plano', text: 'Toca el plano donde quieres escribir', eraser: 'Toca o arrastra sobre una anotación para borrarla' };
    showHint(hints[s.tool] || 'Dibuja con un dedo · usa dos dedos para mover y hacer zoom');
  }
  markupBar.addEventListener('pointerdown', (e) => e.stopPropagation());
  markupBar.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { markup.setTool(b.dataset.tool); syncMarkupBar(); }));
  markupBar.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => { markup.setColor(b.dataset.color); syncMarkupBar(); }));
  markupBar.querySelectorAll('[data-width]').forEach((b) => (b.onclick = () => { markup.setWidth(Number(b.dataset.width)); syncMarkupBar(); }));
  view.querySelector('#markup-undo').onclick = async () => { await markup.undo(); syncMarkupBar(); };
  view.querySelector('#markup-done').onclick = () => {
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
    // Pulsación larga sobre una anotación: seleccionarla
    if (pointers.size === 1 && canTouchMarkups() && tool !== 'eraser') {
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
    if (pointers.size === 1 && tool && !['hand', 'text'].includes(tool)) {
      const p = toPlan(e.clientX, e.clientY);
      if (tool === 'eraser') {
        gesture = { type: 'erase' };
        markup.eraseAt(p).then(syncMarkupBar);
      } else if (markup.start(p)) gesture = { type: 'draw' };
      return;
    }
    if (pointers.size === 2 && gesture?.type === 'draw') markup.cancel();
    if (pointers.size === 1) {
      const pin = e.target.closest('[data-pin]');
      gesture = { type: 'pan', startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, pinId: pin?.dataset.pin, pinEl: pin, t0: Date.now() };
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
    if (gesture.type === 'edit') return markup.editTo(toPlan(e.clientX, e.clientY));
    if (gesture.type === 'draw') return markup.move(toPlan(e.clientX, e.clientY));
    if (gesture.type === 'erase') return void markup.eraseAt(toPlan(e.clientX, e.clientY)).then(syncMarkupBar);
    if (gesture.type === 'pan') {
      if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > TAP_TOLERANCE) gesture.moved = true;
      if (!gesture.moved) return;
      if (gesture.pinId && state.mode === 'view' && canEdit(ctx.project.id)) {
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
    clearTimeout(longPress);
    pressStart = null;
    const g = gesture;
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

    if (g.dragging) {
      const task = ctx.tasks.find((t) => t.id === g.pinId);
      const p = toPlan(e.clientX, e.clientY);
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
      if (markup.settings.tool === 'text') {
        if (!inside(p)) return toast('Toca dentro del plano', 'error');
        markup.addText(p);
        setTimeout(syncMarkupBar, 400);
      }
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
  view.querySelector('#toggle-list').onclick = () => {
    state.listOpen = !state.listOpen;
    drawPins();
  };
  addBtn.onclick = () => setMode(state.mode === 'add' ? 'view' : 'add');
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

  // ---------- Estado inicial ----------
  drawPins();
  applyVisible();
  await markup.load();
  await new Promise((r) => requestAnimationFrame(r));
  fit();
  setMode(state.mode);
  const focusId = params.get('task');
  const focus = focusId && ctx.tasks.find((t) => t.id === focusId && t.sheetId === sheet.id && t.x != null);
  if (focus) {
    centerOn(focus.x, focus.y, fitScale() * 2.5);
    flash(focus.id);
    openTaskDrawer(ctx, focus.id);
  }
}
