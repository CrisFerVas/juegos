// Descarga de planos con anotaciones, mediciones y tareas, en la calidad original.
// - Plano PDF: se copia la página original (vectorial, sin rasterizar) y encima se dibujan las
//   anotaciones también en vectorial. El resultado se puede ampliar tanto como el PDF original.
// - Plano de imagen: se incrusta la imagen original sin recomprimir y se dibuja encima.
// Usa pdf-lib (cdnjs); el service worker lo guarda en caché tras el primer uso.

import { db, fileBlob, statusOf } from './db.js';
import { openDoc } from './hires.js';
import { formatLength, formatArea } from './markup.js';
import { esc, modal, toast, download } from './ui.js';

const PDFLIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
let pdfLibPromise;

export function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFLIB_URL;
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => {
      pdfLibPromise = null;
      s.remove();
      reject(new Error('No se pudo cargar el generador de PDF (¿sin conexión?)'));
    };
    document.head.appendChild(s);
  });
  return pdfLibPromise;
}

const hexRgb = (hex) => {
  const h = String(hex || '#000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Inversa de una matriz afín [a, b, c, d, e, f]. */
function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// ---------- Geometría (en píxeles del plano, eje Y hacia abajo) ----------
// Un trazo es una lista de comandos: ['M', x, y] | ['L', x, y] | ['C', x1, y1, x2, y2, x, y] | ['Z']

/** Arco circular/elíptico de a0 a a1 (radianes) como curvas de Bézier, sin el punto inicial. */
function arcBeziers(cx, cy, rx, ry, a0, a1) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const da = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(da / 4);
  for (let i = 0; i < n; i++) {
    const t0 = a0 + da * i, t1 = t0 + da;
    const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)];
    out.push(['C',
      cx + rx * (c0 - k * s0), cy + ry * (s0 + k * c0),
      cx + rx * (c1 + k * s1), cy + ry * (s1 - k * c1),
      cx + rx * c1, cy + ry * s1]);
  }
  return out;
}

/** Mismo suavizado que en pantalla (cuadráticas entre puntos medios), convertido a cúbicas. */
function smoothCmds(pts) {
  const [x0, y0] = pts[0];
  if (pts.length === 1) return [['M', x0, y0], ['L', x0 + 0.01, y0]];
  const cmds = [['M', x0, y0]];
  let cur = [x0, y0];
  const quad = (q, e) => {
    cmds.push(['C', cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1]), e[0], e[1]]);
    cur = e;
  };
  for (let i = 1; i < pts.length - 1; i++) quad(pts[i], [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]);
  cmds.push(['L', ...pts.at(-1)]);
  return cmds;
}

/** Nube de revisión: semicírculos hacia fuera a lo largo del rectángulo (igual que en pantalla). */
function cloudCmds(x0, y0, x1, y1, sw) {
  const w = x1 - x0, h = y1 - y0;
  const target = Math.max(sw * 6, Math.min(w, h) / 6, 4);
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const cmds = [['M', x0, y0]];
  for (let s = 0; s < 4; s++) {
    const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / (target * 2)));
    for (let i = 0; i < n; i++) {
      const px0 = ax + ((bx - ax) * i) / n, py0 = ay + ((by - ay) * i) / n;
      const px1 = ax + ((bx - ax) * (i + 1)) / n, py1 = ay + ((by - ay) * (i + 1)) / n;
      const cx = (px0 + px1) / 2, cy = (py0 + py1) / 2, r = len / n / 2;
      const a0 = Math.atan2(py0 - cy, px0 - cx);
      cmds.push(...arcBeziers(cx, cy, r, r, a0, a0 + Math.PI));
    }
  }
  return cmds;
}

const ellipseCmds = (cx, cy, rx, ry) => [['M', cx + rx, cy], ...arcBeziers(cx, cy, rx, ry, 0, Math.PI * 2), ['Z']];

function roundRectCmds(x, y, w, h, r) {
  return [
    ['M', x + r, y], ['L', x + w - r, y], ...arcBeziers(x + w - r, y + r, r, r, -Math.PI / 2, 0),
    ['L', x + w, y + h - r], ...arcBeziers(x + w - r, y + h - r, r, r, 0, Math.PI / 2),
    ['L', x + r, y + h], ...arcBeziers(x + r, y + h - r, r, r, Math.PI / 2, Math.PI),
    ['L', x, y + r], ...arcBeziers(x + r, y + r, r, r, Math.PI, Math.PI * 1.5), ['Z'],
  ];
}

// ---------- Dibujo en una página PDF ----------

/**
 * Pintor sobre una página: todo se dibuja en píxeles del plano (0..W, 0..H, Y hacia abajo);
 * la matriz `toPdf` los lleva al espacio de la página.
 */
function createPainter(PDFLib, pdf, page, font, toPdf) {
  const L = PDFLib;
  const ops = [];
  const gsCache = new Map();
  const fontKey = page.node.newFontDictionary(font.name, font.ref);
  const charset = new Set(font.getCharacterSet());
  // La fuente estándar del PDF solo tiene caracteres latinos: algunos símbolos se sustituyen
  const SUBST = { '→': '->', '←': '<-', '↑': '^', '↓': 'v', '≥': '>=', '≤': '<=', '≈': '~', '⌀': 'Ø', '∅': 'Ø', '−': '-', '\t': ' ' };
  const clean = (s) => [...String(s)].map((ch) => (charset.has(ch.codePointAt(0)) ? ch : SUBST[ch] ?? '?')).join('');

  const gs = (fillOpacity = 1, strokeOpacity = 1) => {
    if (fillOpacity >= 1 && strokeOpacity >= 1) return null;
    const k = `${fillOpacity}|${strokeOpacity}`;
    if (!gsCache.has(k)) gsCache.set(k, page.node.newExtGState('GS', pdf.context.obj({ Type: 'ExtGState', ca: fillOpacity, CA: strokeOpacity })));
    return gsCache.get(k);
  };

  function path(cmds, { stroke, width = 1, fill, fillOpacity = 1, strokeOpacity = 1, cap = 'round', join = 'round', dash } = {}) {
    ops.push(L.pushGraphicsState());
    const g = gs(fill ? fillOpacity : 1, stroke ? strokeOpacity : 1);
    if (g) ops.push(L.setGraphicsState(g));
    if (stroke) {
      ops.push(
        L.setStrokingRgbColor(...hexRgb(stroke)),
        L.setLineWidth(width),
        L.setLineCap({ round: L.LineCapStyle.Round, square: L.LineCapStyle.Projecting, butt: L.LineCapStyle.Butt }[cap]),
        L.setLineJoin(join === 'round' ? L.LineJoinStyle.Round : L.LineJoinStyle.Miter)
      );
      if (dash) ops.push(L.setDashPattern(dash, 0));
    }
    if (fill) ops.push(L.setFillingRgbColor(...hexRgb(fill)));
    for (const c of cmds) {
      if (c[0] === 'M') ops.push(L.moveTo(c[1], c[2]));
      else if (c[0] === 'L') ops.push(L.lineTo(c[1], c[2]));
      else if (c[0] === 'C') ops.push(L.appendBezierCurve(c[1], c[2], c[3], c[4], c[5], c[6]));
      else ops.push(L.closePath());
    }
    ops.push(fill && stroke ? L.fillAndStroke() : fill ? L.fill() : L.stroke());
    ops.push(L.popGraphicsState());
  }

  /** Texto en negrita. (x, y) = línea base; align: 'left' | 'center'. Con halo opcional (contorno debajo). */
  function text(str, x, y, size, color, { align = 'left', halo } = {}) {
    const t = clean(str);
    const dx = align === 'center' ? -font.widthOfTextAtSize(t, size) / 2 : 0;
    const passes = halo ? [[1, halo.color, halo.width], [0, color]] : [[0, color]];
    for (const [mode, c, lw] of passes) {
      ops.push(L.pushGraphicsState(), L.beginText(), L.setFontAndSize(fontKey, size));
      // La matriz de texto invierte Y para que las letras queden derechas en el espacio "Y hacia abajo"
      ops.push(L.setTextMatrix(1, 0, 0, -1, x + dx, y));
      if (mode === 1) {
        ops.push(L.setTextRenderingMode(L.TextRenderingMode.Outline), L.setStrokingRgbColor(...hexRgb(c)), L.setLineWidth(lw), L.setLineJoin(L.LineJoinStyle.Round));
      } else {
        ops.push(L.setTextRenderingMode(L.TextRenderingMode.Fill), L.setFillingRgbColor(...hexRgb(c)));
      }
      ops.push(L.showText(font.encodeText(t)), L.endText(), L.popGraphicsState());
    }
  }
  const textWidth = (str, size) => font.widthOfTextAtSize(clean(str), size);

  function flush() {
    // El contenido original queda aislado entre q/Q para que su estado gráfico no afecte a lo añadido
    page.node.normalize();
    const start = pdf.context.register(page.createContentStream(L.pushGraphicsState()));
    const end = pdf.context.register(page.createContentStream(L.popGraphicsState()));
    page.node.wrapContentStreams(start, end);
    page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(...toPdf), ...ops, L.popGraphicsState());
  }
  return { path, text, textWidth, flush };
}

/** Dibuja una anotación (mismo aspecto que en el visor). */
function paintMarkup(p, m, W, H, metersPerPx) {
  const px = ([x, y]) => [x * W, y * H];
  const pts = m.points.map(px);
  const sw = (m.width || 0) * W;
  const color = m.color || '#e11d48';
  const style = { stroke: color, width: sw };
  const [a, b] = [pts[0], pts.at(-1)];
  const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  const length = (list, closed) => {
    if (!metersPerPx) return null;
    let s = 0;
    for (let i = 1; i < list.length; i++) s += dist(list[i], list[i - 1]);
    if (closed && list.length > 2) s += dist(list[0], list.at(-1));
    return s * metersPerPx;
  };
  const label = (x, y, str, fs) => {
    const w = p.textWidth(str, fs) + fs * 0.8, h = fs * 1.45;
    p.path(roundRectCmds(x - w / 2, y - h / 2, w, h, h / 4), { fill: '#ffffff', fillOpacity: 0.92, stroke: color, width: fs * 0.08 });
    p.text(str, x, y + fs * 0.35, fs, color === '#ffffff' ? '#111827' : color, { align: 'center' });
  };

  switch (m.type) {
    case 'pen':
      p.path(smoothCmds(pts), style);
      break;
    case 'marker':
      p.path(smoothCmds(pts), { ...style, strokeOpacity: 0.38, cap: 'square' });
      break;
    case 'line':
      p.path([['M', ...a], ['L', ...b]], style);
      break;
    case 'arrow': {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const Lh = Math.max(sw * 4.5, 6);
      const h1 = [b[0] - Lh * Math.cos(ang - 0.45), b[1] - Lh * Math.sin(ang - 0.45)];
      const h2 = [b[0] - Lh * Math.cos(ang + 0.45), b[1] - Lh * Math.sin(ang + 0.45)];
      const tail = [b[0] - Lh * 0.7 * Math.cos(ang), b[1] - Lh * 0.7 * Math.sin(ang)];
      p.path([['M', ...a], ['L', ...tail]], style);
      p.path([['M', ...b], ['L', ...h1], ['L', ...h2], ['Z']], { stroke: color, width: sw * 0.5, fill: color });
      break;
    }
    case 'rect': {
      const [x0, y0, x1, y1] = box;
      p.path([['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']], style);
      break;
    }
    case 'ellipse': {
      const [x0, y0, x1, y1] = box;
      p.path(ellipseCmds((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2), style);
      break;
    }
    case 'cloud':
      p.path(cloudCmds(...box, sw), style);
      break;
    case 'measure': {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const t = Math.max(sw * 3, 4);
      const nx = -Math.sin(ang) * t, ny = Math.cos(ang) * t;
      p.path([['M', ...a], ['L', ...b]], style);
      p.path([['M', a[0] - nx, a[1] - ny], ['L', a[0] + nx, a[1] + ny]], style);
      p.path([['M', b[0] - nx, b[1] - ny], ['L', b[0] + nx, b[1] + ny]], style);
      const fs = (m.fontSize || 0.006) * W;
      label((a[0] + b[0]) / 2 - nx * 2.2, (a[1] + b[1]) / 2 - ny * 2.2, formatLength(length([a, b])), fs);
      break;
    }
    case 'path':
    case 'area': {
      const isArea = m.type === 'area';
      const cmds = pts.map(([x, y], i) => [i ? 'L' : 'M', x, y]);
      if (isArea) cmds.push(['Z']);
      p.path(cmds, isArea ? { ...style, fill: color, fillOpacity: 0.15 } : style);
      const r = Math.max(sw * 1.2, 2);
      for (const [x, y] of pts) p.path(ellipseCmds(x, y, r, r), { fill: color });
      const fs = (m.fontSize || 0.006) * W;
      if (!isArea && pts.length >= 2) {
        const [x1, y1] = pts.at(-2), [x2, y2] = pts.at(-1);
        label((x1 + x2) / 2, (y1 + y2) / 2 - fs * 1.2, formatLength(length(pts)), fs);
      } else if (isArea && pts.length >= 3) {
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
          s += x1 * y2 - x2 * y1;
        }
        const area = metersPerPx ? (Math.abs(s) / 2) * metersPerPx * metersPerPx : null;
        const cx = pts.reduce((q, v) => q + v[0], 0) / pts.length, cy = pts.reduce((q, v) => q + v[1], 0) / pts.length;
        label(cx, cy, formatArea(area), fs);
      }
      break;
    }
    case 'text': {
      const fs = (m.fontSize || 0.01) * W;
      const halo = { color: color === '#ffffff' ? '#111827' : '#ffffff', width: fs * 0.18 };
      String(m.text || '').split('\n').forEach((line, i) => p.text(line, a[0], a[1] + i * fs * 1.2, fs, color, { halo }));
      break;
    }
  }
}

/** Pin numerado de una tarea (círculo del color de su estado). */
function paintTask(p, t, W, H) {
  const r = Math.max(W, H) * 0.007;
  const x = t.x * W, y = t.y * H;
  const st = statusOf(t.status);
  p.path(ellipseCmds(x, y, r, r), { fill: st.color, stroke: '#ffffff', width: r * 0.2 });
  const label = String(t.number ?? '');
  const fs = r * (label.length > 2 ? 0.85 : 1.1);
  p.text(label, x, y + fs * 0.36, fs, '#ffffff', { align: 'center' });
}

// ---------- Generación del documento ----------

async function imageForPdf(PDFLib, out, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sig = bytes.slice(0, 4);
  if (sig[0] === 0xff && sig[1] === 0xd8) return out.embedJpg(bytes);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return out.embedPng(bytes);
  // Otros formatos (WebP, GIF...): se convierten a PNG sin pérdida
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const png = await new Promise((res) => c.toBlob(res, 'image/png'));
  c.width = c.height = 0;
  return out.embedPng(new Uint8Array(await png.arrayBuffer()));
}

/**
 * Genera un PDF con los planos indicados.
 * @param opts { markups: bool, tasks: bool }
 * @returns Blob (application/pdf)
 */
export async function buildSheetsPdf(ctx, sheets, opts = { markups: true, tasks: true }, onProgress = () => {}) {
  const PDFLib = await loadPdfLib();
  const out = await PDFLib.PDFDocument.create();
  out.setTitle(sheets.length === 1 ? sheets[0].name : `${ctx.project.name} – planos`);
  out.setCreator('ObraPlan');
  out.setProducer('ObraPlan');
  const font = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const allMarkups = opts.markups ? await db.byProject('markups', ctx.project.id) : [];

  // PDF originales: se cargan una vez y se copian todas sus páginas necesarias de golpe
  const srcDocs = new Map(); // pdfFileId -> PDFDocument | null
  for (const s of sheets) {
    if (!s.pdfFileId || srcDocs.has(s.pdfFileId)) continue;
    try {
      const blob = await fileBlob(s.pdfFileId);
      srcDocs.set(s.pdfFileId, blob ? await PDFLib.PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true }) : null);
    } catch {
      srcDocs.set(s.pdfFileId, null); // PDF dañado o cifrado: se usa la imagen base
    }
  }
  const copied = new Map(); // `${fileId}:${page}` -> PDFPage
  for (const [fileId, src] of srcDocs) {
    if (!src) continue;
    const idx = [...new Set(sheets.filter((s) => s.pdfFileId === fileId).map((s) => (s.pdfPage || 1) - 1))].filter((i) => i < src.getPageCount());
    const pages = await out.copyPages(src, idx);
    idx.forEach((i, k) => copied.set(`${fileId}:${i + 1}`, pages[k]));
  }

  const used = new Set();
  for (const [n, s] of sheets.entries()) {
    onProgress(n + 1, sheets.length, s);
    const W = s.width, H = s.height;
    let page, toPdf;
    const key = `${s.pdfFileId}:${s.pdfPage || 1}`;
    if (s.pdfFileId && copied.has(key)) {
      // La misma página no se puede añadir dos veces: se vuelve a copiar si ya se usó
      if (used.has(key)) {
        const [again] = await out.copyPages(srcDocs.get(s.pdfFileId), [(s.pdfPage || 1) - 1]);
        page = out.addPage(again);
      } else page = out.addPage(copied.get(key));
      used.add(key);
      // Píxeles del plano -> espacio de la página: inversa de la transformación con la que se generó la imagen base
      const pdfPage = await (await openDoc(s.pdfFileId)).getPage(s.pdfPage || 1);
      const vp1 = pdfPage.getViewport({ scale: 1 });
      toPdf = invert(pdfPage.getViewport({ scale: W / vp1.width }).transform);
    } else {
      // Imagen: tamaño real si se conoce (plano rasterizado), si no a 150 ppp; como máximo 5 m de lado
      const blob = await fileBlob(s.fileId);
      if (!blob) throw new Error(`No se encuentra el archivo del plano «${s.name}»`);
      const img = await imageForPdf(PDFLib, out, blob);
      let k = s.pageWidthMm ? ((s.pageWidthMm / 25.4) * 72) / W : 72 / 150;
      k = Math.min(k, 14000 / Math.max(W, H));
      page = out.addPage([W * k, H * k]);
      page.drawImage(img, { x: 0, y: 0, width: W * k, height: H * k });
      toPdf = [k, 0, 0, -k, 0, H * k];
    }

    const painter = createPainter(PDFLib, out, page, font, toPdf);
    if (opts.markups) {
      const metersPerPx = s.calibration?.metersPerWidth ? s.calibration.metersPerWidth / W : null;
      allMarkups
        .filter((m) => m.sheetId === s.id && m.type !== 'photo' && m.points?.length)
        .sort((a, b) => a.createdAt - b.createdAt)
        .forEach((m) => paintMarkup(painter, m, W, H, metersPerPx));
    }
    if (opts.tasks) {
      ctx.tasks
        .filter((t) => t.sheetId === s.id && t.x != null)
        .sort((a, b) => a.number - b.number)
        .forEach((t) => paintTask(painter, t, W, H));
    }
    painter.flush();
  }
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// Nombre de archivo solo con ASCII: algunos navegadores descartan el nombre si lleva tildes o rayas largas
const safeName = (s) =>
  String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[–—]/g, '-').replace(/[^\w .()+,-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'plano';

/**
 * Diálogo de descarga. Con `choose`, permite elegir qué planos incluir.
 */
export function openExportDialog(ctx, sheets, { choose = false } = {}) {
  const many = choose && sheets.length > 1;
  modal({
    title: many ? 'Descargar planos en PDF' : 'Descargar plano en PDF',
    sheet: true,
    body: `
      <p class="muted small">Se descarga en la calidad original: los planos PDF siguen siendo vectoriales y
        las anotaciones se añaden encima, nítidas a cualquier zoom.</p>
      <fieldset class="export-opts">
        <legend>Incluir</legend>
        <label class="check-label"><input type="checkbox" name="markups" checked /> Anotaciones y mediciones</label>
        <label class="check-label"><input type="checkbox" name="tasks" checked /> Tareas (pines numerados)</label>
      </fieldset>
      ${many ? `
      <fieldset class="export-opts export-sheets">
        <legend>Planos <button type="button" class="btn btn-sm" id="export-all">Todos / ninguno</button></legend>
        ${sheets.map((s) => `<label class="check-label"><input type="checkbox" data-sheet="${esc(s.id)}" checked /> ${esc(s.name)}</label>`).join('')}
      </fieldset>` : ''}
      <p class="muted small" id="export-status" role="status"></p>`,
    submitLabel: 'Descargar PDF',
    onOpen: (wrap) => {
      const all = wrap.querySelector('#export-all');
      if (all) {
        all.onclick = () => {
          const boxes = [...wrap.querySelectorAll('[data-sheet]')];
          const on = !boxes.every((b) => b.checked);
          boxes.forEach((b) => (b.checked = on));
        };
      }
    },
    onSubmit: async (v, form) => {
      const chosen = many ? sheets.filter((s) => form.querySelector(`[data-sheet="${CSS.escape(s.id)}"]`)?.checked) : sheets;
      if (!chosen.length) {
        toast('Elige al menos un plano', 'error');
        return false;
      }
      const btn = form.querySelector('[type=submit]');
      const status = form.querySelector('#export-status');
      btn.disabled = true;
      try {
        status.textContent = 'Preparando...';
        const blob = await buildSheetsPdf(ctx, chosen, { markups: !!v.markups, tasks: !!v.tasks }, (i, n, s) => {
          status.textContent = n > 1 ? `Plano ${i} de ${n}: ${s.name}` : `Generando ${s.name}...`;
        });
        const name = chosen.length === 1 ? `${safeName(chosen[0].name)}${chosen[0].version > 1 ? ` v${chosen[0].version}` : ''} (anotado).pdf` : `${safeName(ctx.project.name)} - planos.pdf`;
        download(name, blob, 'application/pdf');
        toast(`PDF descargado (${blob.size < 1048576 ? `${Math.max(1, Math.round(blob.size / 1024))} KB` : `${(blob.size / 1048576).toFixed(1)} MB`})`);
      } catch (err) {
        console.error(err);
        status.textContent = '';
        toast(err.message || 'No se pudo generar el PDF', 'error');
        btn.disabled = false;
        return false;
      }
    },
  });
}
