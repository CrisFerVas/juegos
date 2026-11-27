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
  { id: 'measure', n: 'Medir distancia', i: ic('<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>') },
  { id: 'path', n: 'Medir recorrido (toca varios puntos)', i: ic('<path d="M4 19l5-8 5 4 6-10"/><circle cx="4" cy="19" r="1.5"/><circle cx="9" cy="11" r="1.5"/><circle cx="14" cy="15" r="1.5"/><circle cx="20" cy="5" r="1.5"/>') },
  { id: 'area', n: 'Medir área (toca los vértices)', i: ic('<path d="M5 18l2-12 11 3 1 9z"/><path d="M9 14h6" stroke-dasharray="2 2"/>') },
  { id: 'calibrate', n: 'Calibrar escala con una cota conocida', i: ic('<path d="M3 12h18M3 9v6M21 9v6"/><path d="M9 6l2 2 4-4"/>') },
  { id: 'text', n: 'Texto', i: ic('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>') },
  { id: 'eraser', n: 'Borrador (toca o arrastra sobre una anotación)', i: ic('<path d="M8 20h12M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H7.5z"/><path d="M9 11l5 5"/>') },
];

const round = (v) => Math.round(v * 1e5) / 1e5;

const nf2 = new Intl.NumberFormat('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatLength = (m) => (m == null ? 'sin escala' : `${nf2.format(m)} m`);
export const formatArea = (m2) => (m2 == null ? 'sin escala' : `${nf2.format(m2)} m²`);
export const MEASURE_TYPES = ['measure', 'path', 'area'];

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

export function createMarkupLayer({ ctx, sheet, stage, getScale, getCalibration = () => null, onCalibrate = () => {}, onRecord = () => {} }) {
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
  const redoStack = [];
  /** Nueva acción: se puede deshacer y ya no se puede rehacer lo deshecho antes. */
  const record = (entry) => {
    undoStack.push(entry);
    redoStack.length = 0;
    onRecord(); // p. ej. el visor lleva un historial común con sus propias acciones
  };
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

  // ---------- Medición ----------
  /** Metros por píxel del plano según la calibración actual (o null). */
  const metersPerPx = () => {
    const c = getCalibration();
    return c?.metersPerWidth ? c.metersPerWidth / W : null;
  };
  function lengthOf(points, closed = false) {
    const k = metersPerPx();
    if (!k) return null;
    const pts = points.map(px);
    let sum = 0;
    for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (closed && pts.length > 2) sum += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
    return sum * k;
  }
  function areaOf(points) {
    const k = metersPerPx();
    if (!k || points.length < 3) return null;
    const pts = points.map(px);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return (Math.abs(a) / 2) * k * k;
  }
  /** Etiqueta con fondo para las medidas. */
  function label(x, y, text, color, fs) {
    const w = text.length * fs * 0.58 + fs * 0.8, h = fs * 1.45;
    return `<g class="measure-label"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 4}" fill="#fff" fill-opacity="0.92" stroke="${color}" stroke-width="${fs * 0.08}"/>
      <text x="${x}" y="${y + fs * 0.35}" font-size="${fs}" text-anchor="middle" fill="${color === '#ffffff' ? '#111827' : color}" font-family="system-ui, sans-serif" font-weight="700">${esc(text)}</text></g>`;
  }

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
      case 'measure':
      case 'calibrate': {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const t = Math.max(sw * 3, 4);
        const nx = -Math.sin(ang) * t, ny = Math.cos(ang) * t;
        const fs = (m.fontSize || 0.006) * W;
        inner = `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${common}${m.type === 'calibrate' ? ` stroke-dasharray="${sw * 3} ${sw * 2}"` : ''}/>
          <line x1="${a[0] - nx}" y1="${a[1] - ny}" x2="${a[0] + nx}" y2="${a[1] + ny}" ${common}/>
          <line x1="${b[0] - nx}" y1="${b[1] - ny}" x2="${b[0] + nx}" y2="${b[1] + ny}" ${common}/>`;
        if (m.type === 'measure') inner += label((a[0] + b[0]) / 2 - nx * 2.2, (a[1] + b[1]) / 2 - ny * 2.2, formatLength(lengthOf([m.points[0], m.points.at(-1)])), m.color, fs);
        break;
      }
      case 'path':
      case 'area': {
        const fs = (m.fontSize || 0.006) * W;
        const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + (m.type === 'area' && !m.draft ? ' Z' : '');
        inner = `<path d="${d}" ${common.replace('fill="none"', m.type === 'area' ? `fill="${color}" fill-opacity="0.15"` : 'fill="none"')}/>`;
        inner += pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${Math.max(sw * 1.2, 2)}" fill="${color}"/>`).join('');
        if (pts.length >= 2) {
          if (m.type === 'path') {
            const [x1, y1] = pts.at(-2), [x2, y2] = pts.at(-1);
            inner += label((x1 + x2) / 2, (y1 + y2) / 2 - fs * 1.2, formatLength(lengthOf(m.points)), m.color, fs);
          } else if (pts.length >= 3) {
            const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
            inner += label(cx, cy, formatArea(areaOf(m.points)), m.color, fs);
          }
        }
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
    items = (await db.byProject('markups', ctx.project.id)).filter((m) => m.sheetId === sheet.id && m.type !== 'photo').sort((a, b) => a.createdAt - b.createdAt);
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
    if (!['pen', 'marker', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'measure', 'calibrate'].includes(t)) return false;
    draft = { type: t, color: settings.color, width: strokeWidth(), points: [[p.x, p.y], [p.x, p.y]] };
    if (t === 'measure') draft.fontSize = labelSize();
    if (t === 'calibrate') draft.color = '#0f766e';
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
    if (d.type === 'calibrate') return onCalibrate(d.points);
    const doc = await persist(d);
    record({ op: 'add', doc });
  }
  function cancel() {
    draft = null;
    draftG.innerHTML = '';
  }

  // Recorridos y áreas: se construyen punto a punto con toques
  const labelSize = () => (settings.width * 2.5 + 11) / getScale() / W;
  function addVertex(p) {
    const t = settings.tool;
    if (!draft || draft.type !== t) draft = { type: t, color: settings.color, width: strokeWidth(), fontSize: labelSize(), points: [], draft: true };
    // En un área, tocar cerca del primer punto la cierra
    if (t === 'area' && draft.points.length >= 3) {
      const [fx, fy] = px(draft.points[0]);
      if (Math.hypot(fx - p.x * W, fy - p.y * H) * getScale() < 18) return finishMulti();
    }
    draft.points.push([p.x, p.y]);
    draftG.innerHTML = shapeSVG(draft);
    return draft.points.length;
  }
  const multiPending = () => (draft && (draft.type === 'path' || draft.type === 'area') ? draft.points.length : 0);
  async function finishMulti() {
    const d = draft;
    draft = null;
    draftG.innerHTML = '';
    if (!d || d.points.length < (d.type === 'area' ? 3 : 2)) return 0;
    delete d.draft;
    const doc = await persist(d);
    record({ op: 'add', doc });
    return 0;
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
        record({ op: 'add', doc });
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
      case 'area':
        return [...pts, pts[0]];
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
      record({ op: 'del', doc });
      return true;
    }
    return false;
  }

  /** Aplica una entrada del historial y devuelve la contraria (para rehacer o volver a deshacer). */
  async function applyHistory(entry) {
    if (entry.op === 'edit') {
      const item = items.find((m) => m.id === entry.before.id);
      if (!item) return null;
      const after = structuredClone(item);
      Object.assign(item, structuredClone(entry.before));
      await db.put('markups', item);
      render();
      return { op: 'edit', before: after };
    }
    if (entry.op === 'add') {
      // Quitar una anotación añadida
      const doc = items.find((m) => m.id === entry.doc.id) || entry.doc;
      if (sel?.id === doc.id) deselect();
      items = items.filter((m) => m.id !== doc.id);
      render();
      await db.del('markups', doc.id);
      return { op: 'del', doc };
    }
    // Volver a poner una anotación borrada. Un documento borrado no se puede recuperar con el mismo
    // identificador: se vuelve a crear y el historial pasa a referirse al nuevo.
    const { id, _rev, ...rest } = entry.doc;
    const restored = await persist(rest);
    for (const u of [...undoStack, ...redoStack]) {
      if (u.op === 'edit' && u.before.id === id) u.before.id = restored.id;
      else if (u.op !== 'edit' && u.doc.id === id) u.doc = { ...u.doc, id: restored.id };
    }
    return { op: 'add', doc: restored };
  }

  async function undo() {
    const last = undoStack.pop();
    if (!last) return false;
    const inverse = await applyHistory(last);
    if (inverse) redoStack.push(inverse);
    return true;
  }

  /** Rehacer: vuelve a aplicar lo último que se deshizo. */
  async function redo() {
    const next = redoStack.pop();
    if (!next) return false;
    const inverse = await applyHistory(next);
    if (inverse) undoStack.push(inverse);
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
  const isSegment = (m) => m.type === 'line' || m.type === 'arrow' || m.type === 'measure';
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
      if (['rect', 'ellipse', 'cloud', 'area'].includes(m.type)) {
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
    record({ op: 'edit', before: e.orig });
    render();
  }

  async function recolorSelected(color) {
    if (!sel || sel.color === color) return;
    const before = structuredClone(sel);
    sel.color = color;
    render(); // se ve al instante; después se guarda
    record({ op: 'edit', before });
    await db.put('markups', sel);
  }

  async function deleteSelected() {
    if (!sel) return;
    const doc = sel;
    deselect();
    items = items.filter((m) => m.id !== doc.id);
    render();
    await db.del('markups', doc.id);
    record({ op: 'del', doc });
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
    canRedo: () => redoStack.length > 0,
    clearRedo: () => (redoStack.length = 0),
    count: () => items.length,
    load, start, move, end, cancel, addText, eraseAt, undo, redo, addVertex, finishMulti, multiPending, render,
    lengthOf, areaOf,
  };
}
