// Anotaciones libres sobre los planos: lápiz, rotulador, líneas, flechas, formas, nubes de revisión y texto.
// Cada anotación es un documento independiente (almacén "markups"), con coordenadas normalizadas (0-1)
// respecto al plano, así que se sincronizan con el equipo y sobreviven a nuevas versiones del plano.

import { db, uid } from './db.js';
import { esc, modal, userName } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

export const MARKUP_COLORS = [
  { c: '#e11d48', n: 'Rojo' }, { c: '#f97316', n: 'Naranja' }, { c: '#facc15', n: 'Amarillo' },
  { c: '#16a34a', n: 'Verde' }, { c: '#06b6d4', n: 'Turquesa' }, { c: '#2563eb', n: 'Azul' },
  { c: '#7c3aed', n: 'Violeta' }, { c: '#db2777', n: 'Rosa' }, { c: '#111827', n: 'Negro' }, { c: '#ffffff', n: 'Blanco' },
];
export const MARKUP_WIDTHS = [{ w: 2, n: 'Fino' }, { w: 4, n: 'Medio' }, { w: 8, n: 'Grueso' }]; // px de pantalla

const ic = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const MARKUP_TOOLS = [
  { id: 'hand', n: 'Mover el plano', i: ic('<path d="M7 11V6a1.5 1.5 0 0 1 3 0v5M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V11M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L3.5 15a1.5 1.5 0 0 1 2.5-1.7L7 15"/>') },
  { id: 'pen', n: 'Lápiz', i: ic('<path d="M4 20l4-1L19 8a2.1 2.1 0 0 0-3-3L5 16z"/><path d="M14 7l3 3"/>') },
  { id: 'marker', n: 'Rotulador fluorescente', i: ic('<path d="M9 15l-5 5h6l2-2"/><path d="M9 15l3 3 8.5-8.5a2.1 2.1 0 0 0-3-3z"/>') },
  { id: 'line', n: 'Línea', i: ic('<path d="M5 19L19 5"/>') },
  { id: 'arrow', n: 'Flecha', i: ic('<path d="M5 19L19 5M10 5h9v9"/>') },
  { id: 'rect', n: 'Rectángulo', i: ic('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  { id: 'ellipse', n: 'Elipse', i: ic('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>') },
  { id: 'cloud', n: 'Nube de revisión', i: ic('<path d="M7 18a3 3 0 0 1-1-5.8A4 4 0 0 1 13.5 9a3.5 3.5 0 0 1 5.5 3.5A2.8 2.8 0 0 1 18 18z"/>') },
  { id: 'text', n: 'Texto', i: ic('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>') },
  { id: 'eraser', n: 'Borrador (toca o arrastra sobre una anotación)', i: ic('<path d="M8 20h12M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H7.5z"/><path d="M9 11l5 5"/>') },
];

const round = (v) => Math.round(v * 1e5) / 1e5;

/** Contorno de nube de revisión alrededor de un rectángulo (arcos hacia fuera, sentido horario). */
function cloudPath(x0, y0, x1, y1, sw) {
  const w = x1 - x0, h = y1 - y0;
  const target = Math.max(sw * 6, Math.min(w, h) / 6, 4);
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  let d = `M${x0} ${y0}`;
  for (let s = 0; s < 4; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / (target * 2)));
    const r = len / n / 2;
    for (let i = 1; i <= n; i++) d += ` A${r} ${r} 0 0 1 ${ax + ((bx - ax) * i) / n} ${ay + ((by - ay) * i) / n}`;
  }
  return d;
}

/** Trazo suavizado con curvas cuadráticas entre puntos medios. */
function smoothPath(pts) {
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]} l0.01 0`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last[0]} ${last[1]}`;
}

export function createMarkupLayer({ ctx, sheet, stage, getScale }) {
  const W = sheet.width, H = sheet.height;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'markups');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = '<g class="markups-saved"></g><g class="markups-draft"></g><g class="markups-sel"></g>';
  stage.insertBefore(svg, stage.querySelector('.pins'));
  const [savedG, draftG, selG] = svg.children;

  let items = [];
  let draft = null;
  const undoStack = [];
  const settings = { tool: 'pen', color: MARKUP_COLORS[0].c, width: MARKUP_WIDTHS[1].w };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem('obraplan.markup') || '{}'));
  } catch {
    /* sin almacenamiento */
  }
  const saveSettings = () => {
    try {
      localStorage.setItem('obraplan.markup', JSON.stringify(settings));
    } catch {
      /* sin almacenamiento */
    }
  };

  const px = ([x, y]) => [x * W, y * H];

  function shapeSVG(m) {
    const sw = m.width * W;
    const color = esc(m.color);
    const pts = m.points.map(px);
    const common = `stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
    let inner = '';
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const box = () => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    switch (m.type) {
      case 'pen':
        inner = `<path d="${smoothPath(pts)}" ${common}/>`;
        break;
      case 'marker':
        inner = `<path d="${smoothPath(pts)}" stroke="${color}" stroke-width="${sw}" stroke-opacity="0.38" fill="none" stroke-linecap="square" stroke-linejoin="round"/>`;
        break;
      case 'line':
        inner = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${common}/>`;
        break;
      case 'arrow': {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const L = Math.max(sw * 4.5, 6);
        const h1 = [b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)];
        const h2 = [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)];
        const tail = [b[0] - L * 0.7 * Math.cos(ang), b[1] - L * 0.7 * Math.sin(ang)];
        inner = `<line x1="${a[0]}" y1="${a[1]}" x2="${tail[0]}" y2="${tail[1]}" ${common}/>
          <path d="M${b[0]} ${b[1]} L${h1[0]} ${h1[1]} L${h2[0]} ${h2[1]} Z" fill="${color}" stroke="${color}" stroke-width="${sw * 0.5}" stroke-linejoin="round"/>`;
        break;
      }
      case 'rect': {
        const [x0, y0, x1, y1] = box();
        inner = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" ${common}/>`;
        break;
      }
      case 'ellipse': {
        const [x0, y0, x1, y1] = box();
        inner = `<ellipse cx="${(x0 + x1) / 2}" cy="${(y0 + y1) / 2}" rx="${(x1 - x0) / 2}" ry="${(y1 - y0) / 2}" ${common}/>`;
        break;
      }
      case 'cloud': {
        const [x0, y0, x1, y1] = box();
        inner = `<path d="${cloudPath(x0, y0, x1, y1, sw)}" ${common}/>`;
        break;
      }
      case 'text': {
        const fs = m.fontSize * W;
        const lines = String(m.text || '').split('\n');
        inner = `<text x="${a[0]}" y="${a[1]}" font-size="${fs}" fill="${color}" font-family="system-ui, sans-serif" font-weight="700"
          stroke="${m.color === '#ffffff' ? '#111827' : '#ffffff'}" stroke-width="${fs * 0.18}" paint-order="stroke" stroke-linejoin="round">${lines
          .map((l, i) => `<tspan x="${a[0]}" dy="${i === 0 ? 0 : fs * 1.2}">${esc(l) || ' '}</tspan>`)
          .join('')}</text>`;
        break;
      }
    }
    return `<g data-markup="${esc(m.id || 'draft')}">${inner}</g>`;
  }

  function render() {
    savedG.innerHTML = items.map(shapeSVG).join('');
    draftG.innerHTML = draft ? shapeSVG(draft) : '';
    renderSelection();
  }

  async function load() {
    if (edit) return; // no interrumpir una edición en curso
    items = (await db.byProject('markups', ctx.project.id)).filter((m) => m.sheetId === sheet.id).sort((a, b) => a.createdAt - b.createdAt);
    if (sel) {
      sel = items.find((m) => m.id === sel.id) || null;
      if (!sel) onSelect(null);
    }
    render();
  }

  async function persist(m) {
    const doc = {
      id: uid(),
      projectId: ctx.project.id,
      sheetId: sheet.id,
      ...m,
      points: m.points.map(([x, y]) => [round(x), round(y)]),
      author: userName(),
      createdAt: Date.now(),
    };
    await db.put('markups', doc);
    items.push(doc);
    render();
    return doc;
  }

  // ---------- Dibujo ----------
  const strokeWidth = () => {
    const base = settings.width / getScale();
    return (settings.tool === 'marker' ? base * 4 : base) / W;
  };

  function start(p) {
    const t = settings.tool;
    if (!['pen', 'marker', 'line', 'arrow', 'rect', 'ellipse', 'cloud'].includes(t)) return false;
    draft = { type: t, color: settings.color, width: strokeWidth(), points: [[p.x, p.y], [p.x, p.y]] };
    if (t === 'pen' || t === 'marker') draft.points = [[p.x, p.y]];
    render();
    return true;
  }
  function move(p) {
    if (!draft) return;
    if (draft.type === 'pen' || draft.type === 'marker') {
      const [lx, ly] = draft.points[draft.points.length - 1];
      const minStep = 1.5 / getScale();
      if (Math.hypot((p.x - lx) * W, (p.y - ly) * H) < minStep) return;
      draft.points.push([p.x, p.y]);
    } else {
      draft.points[1] = [p.x, p.y];
    }
    draftG.innerHTML = shapeSVG(draft);
  }
  async function end() {
    const d = draft;
    draft = null;
    draftG.innerHTML = '';
    if (!d) return;
    if (!['pen', 'marker'].includes(d.type)) {
      const [[x0, y0], [x1, y1]] = d.points;
      if (Math.hypot((x1 - x0) * W, (y1 - y0) * H) * getScale() < 4) return; // gesto demasiado corto
    }
    const doc = await persist(d);
    undoStack.push({ op: 'add', doc });
  }
  function cancel() {
    draft = null;
    draftG.innerHTML = '';
  }

  function addText(p) {
    const fontSize = (settings.width * 4 + 6) / getScale() / W;
    modal({
      title: 'Añadir texto',
      body: `<label class="field"><span>Texto</span><textarea id="markup-text" name="text" rows="3" required placeholder="Escribe la anotación"></textarea></label>`,
      submitLabel: 'Añadir',
      onSubmit: async (v) => {
        const text = v.text.trim();
        if (!text) return false;
        const doc = await persist({ type: 'text', color: settings.color, width: 0, fontSize: round(fontSize), text, points: [[p.x, p.y]] });
        undoStack.push({ op: 'add', doc });
      },
    });
  }

  // ---------- Borrado ----------
  const distSeg = (px0, py0, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px0 - ax) * dx + (py0 - ay) * dy) / l2)) : 0;
    return Math.hypot(px0 - (ax + t * dx), py0 - (ay + t * dy));
  };
  function outline(m) {
    const pts = m.points.map(px);
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const [x0, y0, x1, y1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    switch (m.type) {
      case 'rect':
      case 'cloud':
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      case 'ellipse':
        return Array.from({ length: 49 }, (_, i) => {
          const t = (i / 48) * Math.PI * 2;
          return [(x0 + x1) / 2 + ((x1 - x0) / 2) * Math.cos(t), (y0 + y1) / 2 + ((y1 - y0) / 2) * Math.sin(t)];
        });
      default:
        return pts.length === 1 ? [pts[0], pts[0]] : pts;
    }
  }
  function hit(m, x, y, tol) {
    if (m.type === 'text') {
      const [x0, y0, x1, y1] = bbox(m);
      return x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol;
    }
    const o = outline(m);
    const t = tol + (m.width * W) / 2;
    for (let i = 0; i < o.length - 1; i++) if (distSeg(x, y, o[i][0], o[i][1], o[i + 1][0], o[i + 1][1]) <= t) return true;
    return false;
  }
  async function eraseAt(p) {
    const x = p.x * W, y = p.y * H;
    const tol = 10 / getScale();
    for (let i = items.length - 1; i >= 0; i--) {
      if (!hit(items[i], x, y, tol)) continue;
      const [doc] = items.splice(i, 1);
      if (sel?.id === doc.id) deselect();
      render();
      await db.del('markups', doc.id);
      undoStack.push({ op: 'del', doc });
      return true;
    }
    return false;
  }

  async function undo() {
    const last = undoStack.pop();
    if (!last) return false;
    if (last.op === 'edit') {
      const item = items.find((m) => m.id === last.before.id);
      if (item) {
        Object.assign(item, structuredClone(last.before));
        await db.put('markups', item);
        render();
      }
      return true;
    }
    if (last.op === 'add') {
      if (sel?.id === last.doc.id) deselect();
      items = items.filter((m) => m.id !== last.doc.id);
      render();
      await db.del('markups', last.doc.id);
    } else {
      // Un documento borrado no se puede recuperar con el mismo identificador: se vuelve a crear.
      const { id, _rev, ...rest } = last.doc;
      const restored = await persist(rest);
      // Los cambios anteriores de esa anotación pasan a referirse a la restaurada
      for (const u of undoStack) if (u.op === 'edit' && u.before.id === id) u.before.id = restored.id;
    }
    return true;
  }

  // ---------- Selección, mover y redimensionar ----------
  let sel = null; // anotación seleccionada (objeto de `items`)
  let edit = null; // { handle, start, orig, box }
  let onSelect = () => {};

  /** Caja de la anotación en píxeles del plano: [x0, y0, x1, y1]. */
  function bbox(m) {
    if (m.type === 'text') {
      // Medida real del texto ya dibujado; si aún no existe, una estimación
      const el = m.id && savedG.querySelector(`[data-markup="${CSS.escape(m.id)}"] text`);
      if (el) {
        try {
          const b = el.getBBox();
          if (b.width) return [b.x, b.y, b.x + b.width, b.y + b.height];
        } catch {
          /* elemento oculto */
        }
      }
      const fs = m.fontSize * W;
      const lines = String(m.text).split('\n');
      const [ax, ay] = px(m.points[0]);
      return [ax, ay - fs * 0.9, ax + Math.max(...lines.map((l) => l.length)) * fs * 0.62, ay + (lines.length - 1) * fs * 1.2 + fs * 0.3];
    }
    const pts = m.points.map(px);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const isSegment = (m) => m.type === 'line' || m.type === 'arrow';
  function handles(m) {
    if (isSegment(m)) return [['p0', px(m.points[0])], ['p1', px(m.points[m.points.length - 1])]];
    const [x0, y0, x1, y1] = bbox(m);
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const all = [['nw', [x0, y0]], ['n', [mx, y0]], ['ne', [x1, y0]], ['e', [x1, my]], ['se', [x1, y1]], ['s', [mx, y1]], ['sw', [x0, y1]], ['w', [x0, my]]];
    return m.type === 'text' ? all.filter(([h]) => h.length === 2) : all;
  }

  function renderSelection() {
    if (!sel) {
      selG.innerHTML = '';
      return;
    }
    const k = 1 / getScale();
    let out = '';
    if (!isSegment(sel)) {
      const [x0, y0, x1, y1] = bbox(sel);
      const pad = 6 * k;
      out += `<rect x="${x0 - pad}" y="${y0 - pad}" width="${x1 - x0 + pad * 2}" height="${y1 - y0 + pad * 2}" fill="rgba(15,118,110,.06)"
        stroke="#0f766e" stroke-width="${1.5 * k}" stroke-dasharray="${6 * k} ${4 * k}"/>`;
    }
    for (const [, [x, y]] of handles(sel)) {
      out += `<circle cx="${x}" cy="${y}" r="${7 * k}" fill="#fff" stroke="#0f766e" stroke-width="${2.5 * k}"/>`;
    }
    selG.innerHTML = out;
  }

  /** Anotación bajo un punto (la de más arriba), o null. */
  function hitTest(p) {
    const x = p.x * W, y = p.y * H;
    const tol = 12 / getScale();
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (hit(m, x, y, tol)) return m;
      // Las figuras cerradas también se pueden coger por dentro
      if (['rect', 'ellipse', 'cloud'].includes(m.type)) {
        const [x0, y0, x1, y1] = bbox(m);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return m;
      }
    }
    return null;
  }

  function select(m) {
    sel = m;
    renderSelection();
    onSelect(sel);
  }
  function deselect() {
    if (!sel) return;
    sel = null;
    edit = null;
    renderSelection();
    onSelect(null);
  }

  /** ¿Qué parte de la selección hay bajo el punto? Un tirador, 'move' o null. */
  function pickSelection(p) {
    if (!sel) return null;
    const x = p.x * W, y = p.y * H;
    const tol = 16 / getScale();
    for (const [h, [hx, hy]] of handles(sel)) if (Math.hypot(x - hx, y - hy) <= tol) return h;
    if (isSegment(sel)) return hit(sel, x, y, tol) ? 'move' : null;
    const [x0, y0, x1, y1] = bbox(sel);
    return x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol ? 'move' : null;
  }

  function beginEdit(handle, p) {
    if (!sel) return;
    edit = { handle, start: [p.x * W, p.y * H], orig: structuredClone(sel), box: bbox(sel), changed: false };
  }

  function editTo(p) {
    if (!edit || !sel) return;
    const { handle, start, orig, box } = edit;
    const x = p.x * W, y = p.y * H;
    const dx = x - start[0], dy = y - start[1];
    edit.changed = edit.changed || Math.hypot(dx, dy) > 0.5;
    const norm = ([px0, py0]) => [px0 / W, py0 / H];
    if (handle === 'move') {
      sel.points = orig.points.map(([qx, qy]) => [qx + dx / W, qy + dy / H]);
    } else if (handle === 'p0' || handle === 'p1') {
      sel.points = orig.points.map((q) => [...q]);
      sel.points[handle === 'p0' ? 0 : sel.points.length - 1] = norm([x, y]);
    } else {
      let [x0, y0, x1, y1] = box;
      if (handle.includes('w')) x0 += dx;
      if (handle.includes('e')) x1 += dx;
      if (handle.includes('n')) y0 += dy;
      if (handle.includes('s')) y1 += dy;
      if (orig.type === 'text') {
        // El texto se escala de forma proporcional desde la esquina opuesta
        const k = Math.max(0.15, (y1 - y0) / (box[3] - box[1]));
        sel.fontSize = orig.fontSize * k;
        const newH = (box[3] - box[1]) * k, newW = (box[2] - box[0]) * k;
        const left = handle.includes('w') ? box[2] - newW : box[0];
        const top = handle.includes('n') ? box[3] - newH : box[1];
        // El punto de anclaje (línea base) guarda la misma proporción respecto a la caja
        const [ax, ay] = px(orig.points[0]);
        sel.points = [norm([left + (ax - box[0]) * k, top + (ay - box[1]) * k])];
      } else {
        const bw = box[2] - box[0], bh = box[3] - box[1];
        sel.points = orig.points.map(([qx, qy]) => {
          const [ox, oy] = [qx * W, qy * H];
          return norm([bw ? x0 + ((ox - box[0]) / bw) * (x1 - x0) : ox + (x0 - box[0]), bh ? y0 + ((oy - box[1]) / bh) * (y1 - y0) : oy + (y0 - box[1])]);
        });
      }
    }
    savedG.innerHTML = items.map(shapeSVG).join('');
    renderSelection();
  }

  async function endEdit() {
    const e = edit;
    edit = null;
    if (!e || !sel || !e.changed) return;
    sel.points = sel.points.map(([qx, qy]) => [round(qx), round(qy)]);
    if (sel.fontSize) sel.fontSize = round(sel.fontSize);
    await db.put('markups', sel);
    undoStack.push({ op: 'edit', before: e.orig });
    render();
  }

  async function recolorSelected(color) {
    if (!sel || sel.color === color) return;
    const before = structuredClone(sel);
    sel.color = color;
    render(); // se ve al instante; después se guarda
    undoStack.push({ op: 'edit', before });
    await db.put('markups', sel);
  }

  async function deleteSelected() {
    if (!sel) return;
    const doc = sel;
    deselect();
    items = items.filter((m) => m.id !== doc.id);
    render();
    await db.del('markups', doc.id);
    undoStack.push({ op: 'del', doc });
  }

  return {
    hitTest, select, deselect, pickSelection, beginEdit, editTo, endEdit, recolorSelected, deleteSelected,
    selected: () => sel,
    isEditing: () => !!edit,
    refreshSelection: renderSelection,
    onSelectionChange: (fn) => (onSelect = fn),
    settings,
    setTool: (t) => { settings.tool = t; saveSettings(); },
    setColor: (c) => { settings.color = c; saveSettings(); },
    setWidth: (w) => { settings.width = w; saveSettings(); },
    setVisible: (v) => svg.classList.toggle('hidden', !v),
    canUndo: () => undoStack.length > 0,
    count: () => items.length,
    load, start, move, end, cancel, addText, eraseAt, undo,
  };
}
