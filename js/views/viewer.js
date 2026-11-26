import { db, STATUSES, statusOf, saveTask, fileUrl, isOverdue } from '../db.js';
import { esc, toast, avatar, fmtDate, userName } from '../ui.js';
import { openTaskDrawer, newTaskForm } from './taskDetail.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const TAP_TOLERANCE = 6;

export async function renderViewer(view, ctx, sheetId, params) {
  const sheet = ctx.sheet(sheetId);
  if (!sheet) {
    view.innerHTML = `<div class="empty"><h2>Plano no encontrado</h2><a class="btn" href="#/p/${ctx.project.id}/plans">Volver a planos</a></div>`;
    return;
  }
  const src = await fileUrl(sheet.fileId);
  const W = sheet.width, H = sheet.height;

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
        <button class="btn btn-primary" id="add-mode">＋ Tarea</button>
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
  const apply = () => {
    stage.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    stage.style.setProperty('--inv', 1 / state.scale);
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
    state.mode = mode;
    canvas.classList.toggle('mode-add', mode !== 'view');
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

  // Actualiza sólo los pines cuando cambia una tarea desde el panel lateral.
  ctx.onTaskChanged = async () => {
    await ctx.reload();
    drawPins();
  };

  // ---------- Interacción ----------
  const pointers = new Map();
  let gesture = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    if (gesture.type === 'pan') {
      if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > TAP_TOLERANCE) gesture.moved = true;
      if (!gesture.moved) return;
      if (gesture.pinId && state.mode === 'view') {
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
    const g = gesture;
    if (pointers.size > 0) {
      // Al levantar un dedo del pellizco, continuar paneando con el otro
      const [p] = [...pointers.values()];
      gesture = { type: 'pan', startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: true };
      return;
    }
    gesture = null;
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
  addBtn.onclick = () => setMode(state.mode === 'view' ? 'add' : 'view');
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

  // ---------- Estado inicial ----------
  drawPins();
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
