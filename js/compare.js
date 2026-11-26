// Comparación de versiones de un plano.
// - Superposición: rojo = sólo en la versión anterior (eliminado), azul = sólo en la actual (nuevo),
//   gris = sin cambios.
// - Cortina: una línea vertical que se desliza; a la izquierda la versión actual, a la derecha la anterior.

import { fileBlob, fileUrl } from './db.js';
import { openDoc, createPdfLayer } from './hires.js';

// Píxeles máximos de la imagen de superposición (memoria razonable también en móviles)
const MAX_OVERLAY_PIXELS = 7_000_000;
const overlayCache = new Map(); // `${a}|${b}` -> canvas

async function bitmap(fileId) {
  const blob = await fileBlob(fileId);
  if (!blob) throw new Error('No se pudo cargar una de las versiones (¿sin conexión?)');
  return createImageBitmap(blob);
}

// Imágenes completas en memoria para recortar zonas a resolución de pantalla
const bitmapCache = new Map();
function cachedBitmap(fileId) {
  if (!bitmapCache.has(fileId)) {
    const p = bitmap(fileId);
    p.catch(() => bitmapCache.delete(fileId));
    bitmapCache.set(fileId, p);
    while (bitmapCache.size > 3) {
      const [k, old] = bitmapCache.entries().next().value;
      bitmapCache.delete(k);
      old.then((b) => b.close?.()).catch(() => {});
    }
  }
  return bitmapCache.get(fileId);
}

/** Dibuja la zona [x0, y0] (coordenadas del plano actual, W×H) de una versión a `k` píxeles por píxel. */
async function drawRegion(v, g, { x0, y0, k, W, H, cw, ch }) {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cw, ch);
  if (v.pdfFileId) {
    try {
      const page = await (await openDoc(v.pdfFileId)).getPage(v.pdfPage || 1);
      const vp1 = page.getViewport({ scale: 1 });
      await page.render({ canvasContext: g, viewport: page.getViewport({ scale: (W / vp1.width) * k }), transform: [1, 0, 0, 1, -x0 * k, -y0 * k] }).promise;
      return;
    } catch {
      /* sin lector de PDF: se usa la imagen */
    }
  }
  const bmp = await cachedBitmap(v.fileId);
  const sx = bmp.width / W, sy = bmp.height / H;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, x0 * sx, y0 * sy, (cw / k) * sx, (ch / k) * sy, 0, 0, cw, ch);
}

/** Combina dos imágenes del mismo tamaño en la superposición de colores (in situ sobre `a`). */
function diffPixels(a, b) {
  const d = a.data;
  for (let i = 0; i < d.length; i += 4) {
    // Luminosidad (0 = trazo oscuro, 255 = papel blanco) de cada versión
    const ln = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const lo = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    // Lo común se aclara a gris; lo que sólo está en una versión queda saturado
    const light = (255 - Math.max(ln, lo)) * 0.55;
    d[i] = ln + light; // rojo: presente sólo en la anterior
    d[i + 1] = Math.min(ln, lo) + light;
    d[i + 2] = lo + light; // azul: presente sólo en la actual
  }
}

/** Superposición de todo el plano (vista general), escalada a un tamaño razonable. */
export async function buildOverlay(currentFileId, previousFileId, W, H) {
  const key = `${currentFileId}|${previousFileId}`;
  if (overlayCache.has(key)) return overlayCache.get(key);
  const k = Math.min(1, Math.sqrt(MAX_OVERLAY_PIXELS / (W * H)));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const [cur, prev] = await Promise.all([cachedBitmap(currentFileId), cachedBitmap(previousFileId)]);
  const draw = (img) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return c;
  };
  const cOut = draw(cur);
  const cPrev = draw(prev);
  const gOut = cOut.getContext('2d');
  const a = gOut.getImageData(0, 0, w, h);
  diffPixels(a, cPrev.getContext('2d').getImageData(0, 0, w, h).data);
  gOut.putImageData(a, 0, 0);
  cPrev.width = cPrev.height = 0;
  cOut.className = 'compare-overlay';
  overlayCache.set(key, cOut);
  while (overlayCache.size > 2) overlayCache.delete(overlayCache.keys().next().value);
  return cOut;
}

const MAX_DIFF_PIXELS = 6_000_000;

/** Superposición nítida de la zona visible, recalculada al hacer zoom o desplazar. */
function createDiffLayer({ stage, container, getState, current, previous, W, H, baseK }) {
  let timer = null;
  let gen = 0;
  let shown = null;
  const clear = () => {
    shown?.remove();
    shown = null;
  };
  async function render() {
    const { scale, tx, ty } = getState();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (scale * dpr <= baseK * 1.15) return clear(); // la superposición base ya basta
    const r = container.getBoundingClientRect();
    const x0 = Math.max(0, -tx / scale), y0 = Math.max(0, -ty / scale);
    const x1 = Math.min(W, (r.width - tx) / scale), y1 = Math.min(H, (r.height - ty) / scale);
    if (x1 <= x0 || y1 <= y0) return clear();
    let k = scale * dpr;
    const area = (x1 - x0) * (y1 - y0) * k * k;
    if (area > MAX_DIFF_PIXELS) k *= Math.sqrt(MAX_DIFF_PIXELS / area);
    const cw = Math.ceil((x1 - x0) * k), ch = Math.ceil((y1 - y0) * k);
    const g0 = ++gen;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      return c;
    };
    const ca = mk(), cb = mk();
    const ga = ca.getContext('2d', { willReadFrequently: true }), gb = cb.getContext('2d', { willReadFrequently: true });
    const opts = { x0, y0, k, W, H, cw, ch };
    try {
      await Promise.all([drawRegion(current, ga, opts), drawRegion(previous, gb, opts)]);
    } catch {
      return;
    }
    if (g0 !== gen || !stage.isConnected) return;
    const a = ga.getImageData(0, 0, cw, ch);
    diffPixels(a, gb.getImageData(0, 0, cw, ch).data);
    ga.putImageData(a, 0, 0);
    cb.width = cb.height = 0;
    ca.className = 'compare-diff';
    Object.assign(ca.style, { left: `${x0}px`, top: `${y0}px`, width: `${cw / k}px`, height: `${ch / k}px` });
    clear();
    shown = ca;
    stage.insertBefore(ca, stage.querySelector('.markups, .pins'));
  }
  return {
    schedule(delay = 250) {
      clearTimeout(timer);
      timer = setTimeout(render, delay);
    },
    destroy() {
      clearTimeout(timer);
      gen++;
      clear();
    },
  };
}

/**
 * Controla la comparación dentro del visor.
 * @param stage     elemento transformado del plano
 * @param container área visible (para la cortina)
 * @param getState  () => ({ scale, tx, ty })
 */
export function createCompare({ sheet, stage, container, getState }) {
  let mode = null; // 'overlay' | 'curtain' | null
  let other = null; // versión anterior elegida
  let overlay = null;
  let oldImg = null;
  let oldWrap = null;
  let diffLayer = null;
  let oldPdfLayer = null;
  let divider = null;
  let split = 0.5; // posición de la cortina (fracción del ancho visible)
  const before = () => stage.querySelector('.markups, .pins');

  function clearLayers() {
    diffLayer?.destroy();
    overlay?.remove();
    oldWrap?.remove();
    divider?.remove();
    overlay = oldImg = oldWrap = divider = diffLayer = oldPdfLayer = null;
  }

  function updateCurtain() {
    if (mode !== 'curtain' || !oldWrap) return;
    const { scale, tx } = getState();
    const r = container.getBoundingClientRect();
    const xScreen = r.width * split;
    const xStage = Math.max(0, Math.min(sheet.width, (xScreen - tx) / scale));
    oldWrap.style.clipPath = `inset(0 0 0 ${xStage}px)`;
    divider.style.left = `${xScreen}px`;
  }

  async function show(version, newMode) {
    other = version;
    mode = newMode;
    clearLayers();
    if (mode === 'overlay') {
      overlay = await buildOverlay(sheet.fileId, other.fileId, sheet.width, sheet.height);
      if (mode !== 'overlay' || other !== version) return; // cambió mientras se calculaba
      stage.insertBefore(overlay, before());
      diffLayer = createDiffLayer({ stage, container, getState, current: sheet, previous: other, W: sheet.width, H: sheet.height, baseK: overlay.width / sheet.width });
      diffLayer.schedule(0);
    } else {
      oldImg = document.createElement('img');
      oldImg.className = 'compare-old';
      oldImg.alt = `Versión ${other.version}`;
      oldImg.draggable = false;
      oldImg.src = await fileUrl(other.fileId);
      if (!oldImg.src) throw new Error('No se pudo cargar la versión anterior (¿sin conexión?)');
      // La versión anterior (imagen + redibujado nítido de su PDF) va en una capa recortada por la cortina
      oldWrap = document.createElement('div');
      oldWrap.className = 'compare-old-wrap';
      oldWrap.appendChild(oldImg);
      stage.insertBefore(oldWrap, before());
      oldPdfLayer = createPdfLayer({ sheet: { pdfFileId: other.pdfFileId, pdfPage: other.pdfPage, width: sheet.width, height: sheet.height }, stage: oldWrap, container, getState });
      divider = document.createElement('div');
      divider.className = 'compare-divider';
      divider.innerHTML = `<span class="compare-tag left">v${sheet.version || 1} · actual</span><button class="compare-handle" aria-label="Arrastrar la cortina">⇔</button><span class="compare-tag right">v${other.version}</span>`;
      container.appendChild(divider);
      const handle = divider.querySelector('.compare-handle');
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const r = container.getBoundingClientRect();
        const move = (ev) => {
          split = Math.min(0.98, Math.max(0.02, (ev.clientX - r.left) / r.width));
          updateCurtain();
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      updateCurtain();
    }
  }

  return {
    show,
    close() {
      mode = null;
      other = null;
      clearLayers();
    },
    update() {
      updateCurtain();
      diffLayer?.schedule();
      oldPdfLayer?.schedule();
    },
    active: () => !!mode,
    mode: () => mode,
    /** Diferencia de proporciones entre versiones (si es grande, la superposición no coincidirá). */
    aspectMismatch: (v) => Math.abs(sheet.width / sheet.height - v.width / v.height) / (sheet.width / sheet.height),
  };
}
