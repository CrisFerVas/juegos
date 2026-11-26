// Capa de alta resolución para planos PDF.
// Al acercar el zoom, la zona visible se redibuja desde el PDF vectorial original a la resolución
// real de la pantalla, de modo que líneas y textos se ven nítidos a cualquier ampliación.
// Mientras tanto (o sin conexión, si el lector de PDF no está disponible) se ve la imagen base.

import { loadPdfJs } from './media.js';
import { fileBlob } from './db.js';

const MAX_CANVAS_PIXELS = 16_000_000; // límite de lienzo en navegadores móviles
const docs = new Map(); // fileId -> Promise<PDFDocumentProxy>  (caché pequeña)

export function openDoc(fileId) {
  if (!docs.has(fileId)) {
    const p = (async () => {
      const blob = await fileBlob(fileId);
      if (!blob) throw new Error('PDF no disponible');
      const pdfjs = await loadPdfJs();
      return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    })();
    p.catch(() => docs.delete(fileId));
    docs.set(fileId, p);
    // Mantener como mucho 3 documentos abiertos
    while (docs.size > 3) {
      const [oldId, oldDoc] = docs.entries().next().value;
      docs.delete(oldId);
      oldDoc.then((d) => d.destroy()).catch(() => {});
    }
  }
  return docs.get(fileId);
}

/** Ancho real del papel en mm de un plano PDF (para planos subidos antes de guardarse este dato). */
export async function pdfPageWidthMm(sheet) {
  if (sheet.pageWidthMm) return sheet.pageWidthMm;
  if (!sheet.pdfFileId) return null;
  try {
    const page = await (await openDoc(sheet.pdfFileId)).getPage(sheet.pdfPage || 1);
    return Math.round((page.getViewport({ scale: 1 }).width / 72) * 25.4 * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * @param sheet     plano (necesita pdfFileId, pdfPage, width)
 * @param stage     elemento transformado que contiene la imagen base y los pines
 * @param container área visible del visor
 * @param getState  () => ({ scale, tx, ty }) transformación actual del stage
 */
export function createPdfLayer({ sheet, stage, container, getState }) {
  const noop = { schedule() {}, setEnabled() {}, ready: Promise.resolve(false) };
  if (!sheet.pdfFileId) return noop;

  let page = null;
  let task = null;
  let timer = null;
  let current = null; // lienzo mostrado
  let generation = 0;
  let enabled = true;

  const ready = openDoc(sheet.pdfFileId)
    .then((doc) => doc.getPage(sheet.pdfPage || 1))
    .then((p) => {
      page = p;
      schedule(0);
      return true;
    })
    .catch(() => false);

  function schedule(delay = 200) {
    clearTimeout(timer);
    timer = setTimeout(render, delay);
  }

  function clear() {
    current?.remove();
    current = null;
  }

  async function render() {
    if (!enabled || !page || !stage.isConnected) return;
    const { scale, tx, ty } = getState();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Sólo merece la pena cuando la pantalla muestra más detalle que la imagen base.
    if (scale * dpr <= 1.05) {
      task?.cancel();
      clear();
      return;
    }
    const W = sheet.width;
    const H = sheet.height;
    const rect = container.getBoundingClientRect();
    // Zona visible del plano, en coordenadas del stage (píxeles de la imagen base)
    const x0 = Math.max(0, -tx / scale);
    const y0 = Math.max(0, -ty / scale);
    const x1 = Math.min(W, (rect.width - tx) / scale);
    const y1 = Math.min(H, (rect.height - ty) / scale);
    if (x1 <= x0 || y1 <= y0) return clear();

    let k = scale * dpr; // píxeles de lienzo por píxel de la imagen base
    const area = (x1 - x0) * (y1 - y0) * k * k;
    if (area > MAX_CANVAS_PIXELS) k *= Math.sqrt(MAX_CANVAS_PIXELS / area);

    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (W / vp1.width) * k });
    const canvas = document.createElement('canvas');
    canvas.className = 'hires';
    canvas.width = Math.ceil((x1 - x0) * k);
    canvas.height = Math.ceil((y1 - y0) * k);
    Object.assign(canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${canvas.width / k}px`, height: `${canvas.height / k}px` });

    task?.cancel();
    const gen = ++generation;
    task = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: [1, 0, 0, 1, -x0 * k, -y0 * k],
    });
    try {
      await task.promise;
    } catch {
      return; // cancelado por un nuevo zoom/desplazamiento
    }
    if (gen !== generation || !stage.isConnected) return;
    clear();
    current = canvas;
    // Debajo de las anotaciones y los pines
    stage.insertBefore(canvas, stage.querySelector('.markups, .pins'));
  }

  /** Se desactiva mientras se comparan versiones (la imagen de comparación va debajo). */
  function setEnabled(v) {
    enabled = v;
    if (!v) {
      task?.cancel();
      generation++;
      clear();
    } else schedule(0);
  }

  return { schedule, ready, setEnabled };
}
