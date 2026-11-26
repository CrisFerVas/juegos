// Procesado de planos (PDF / imagen), miniaturas y compresión de fotos.

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let pdfjsPromise;

export function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${PDFJS_BASE}/pdf.min.js`;
    s.onload = () => {
      // El worker se crea desde un blob local que importa el script del CDN: evita el bloqueo
      // de workers de otro origen (si aun así falla, pdf.js usa su modo sin worker).
      const shim = new Blob([`importScripts('${PDFJS_BASE}/pdf.worker.min.js');`], { type: 'text/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(shim);
      resolve(window.pdfjsLib);
    };
    s.onerror = () => {
      pdfjsPromise = null;
      reject(new Error('No se pudo cargar el lector de PDF (¿sin conexión?)'));
    };
    document.head.appendChild(s);
  });
  return pdfjsPromise;
}

const canvasToBlob = (canvas, type = 'image/jpeg', quality = 0.9) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Imagen no válida'));
    };
    img.src = url;
  });
}

/** Redimensiona una imagen para que su lado mayor no supere `max`. */
export async function resizeImage(blob, max = 1600, type = 'image/jpeg', quality = 0.85) {
  const img = await loadImage(blob);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { blob: await canvasToBlob(c, type, quality), width: w, height: h };
}

// Límite de píxeles del raster base: los navegadores móviles (iOS) no admiten lienzos mayores de ~16,7 Mpx.
const MAX_RASTER_PIXELS = 16_000_000;
const MAX_RASTER_SIDE = 8192;

/** Miniatura JPEG dibujada directamente desde un lienzo o imagen ya cargados. */
async function thumbFrom(source, w, h, max = 480) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.85);
}

/**
 * Convierte un archivo de plano en una lista de hojas.
 * - PDF: se conserva el PDF original (para redibujar en vectorial al hacer zoom) y se genera
 *   por página una imagen base sin pérdida (PNG) de la mayor resolución que admite el navegador.
 * - Imagen: se conserva el archivo original sin recomprimir.
 * Devuelve { pdf?: Blob, sheets: [{ name, blob, thumb, width, height, pdfPage? }] }
 */
export async function fileToSheets(file, onProgress = () => {}) {
  const base = file.name.replace(/\.[^.]+$/, '');
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const sheets = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(
        MAX_RASTER_SIDE / Math.max(vp1.width, vp1.height),
        Math.sqrt(MAX_RASTER_PIXELS / (vp1.width * vp1.height)),
        6
      );
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await canvasToBlob(c, 'image/png');
      const thumb = await thumbFrom(c, c.width, c.height);
      sheets.push({
        name: pdf.numPages > 1 ? `${base} – pág. ${i}` : base, blob, thumb, width: c.width, height: c.height, pdfPage: i,
        // Tamaño real del papel (1 pt = 1/72 pulgada): permite calibrar con la escala del plano (1:50, 1:100...)
        pageWidthMm: Math.round((vp1.width / 72) * 25.4 * 10) / 10,
      });
      c.width = c.height = 0;
      page.cleanup();
    }
    await pdf.destroy();
    return { pdf: file, sheets };
  }
  if (file.type.startsWith('image/')) {
    onProgress(1, 1);
    const img = await loadImage(file);
    const thumb = await thumbFrom(img, img.naturalWidth, img.naturalHeight);
    // Se guarda el archivo original tal cual: sin reducir ni recomprimir.
    return { sheets: [{ name: base, blob: file, thumb, width: img.naturalWidth, height: img.naturalHeight }] };
  }
  throw new Error(`Formato no soportado: ${file.name}`);
}

/** Genera un plano de planta de ejemplo para el proyecto demo. */
export async function demoFloorPlan(variant = 0) {
  const W = 2400, H = 1600;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Rejilla de ejes
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#94a3b8';
  const cols = ['A', 'B', 'C', 'D', 'E', 'F'];
  cols.forEach((l, i) => {
    const x = 200 + i * 400;
    ctx.setLineDash([12, 10]);
    ctx.beginPath();
    ctx.moveTo(x, 80);
    ctx.lineTo(x, H - 180);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, 60, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(l, x - 9, 70);
  });
  for (let j = 0; j < 4; j++) {
    const y = 200 + j * 400;
    ctx.setLineDash([12, 10]);
    ctx.beginPath();
    ctx.moveTo(80, y);
    ctx.lineTo(W - 80, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(55, y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(String(j + 1), 46, y + 10);
  }

  // Muros exteriores
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 18;
  ctx.strokeRect(200, 200, 2000, 1200);

  // Tabiques interiores
  ctx.lineWidth = 9;
  const walls = variant === 0
    ? [[1000, 200, 1000, 900], [200, 900, 1500, 900], [1500, 600, 1500, 1400], [1500, 600, 2200, 600], [600, 900, 600, 1400], [1800, 600, 1800, 1000]]
    : [[800, 200, 800, 1400], [800, 700, 2200, 700], [1500, 200, 1500, 700], [1400, 700, 1400, 1400], [1800, 700, 1800, 1400]];
  walls.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });

  // Puertas (huecos + arco)
  ctx.lineWidth = 3;
  const doors = variant === 0 ? [[800, 900], [1250, 900], [1500, 1150], [1650, 600], [400, 900]] : [[800, 1000], [1100, 700], [1600, 700], [1400, 1000], [2000, 700]];
  doors.forEach(([x, y]) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 45, y - 12, 90, 24);
    ctx.beginPath();
    ctx.arc(x - 45, y, 90, -Math.PI / 2, 0);
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  });

  // Nombres de estancias
  ctx.fillStyle = '#334155';
  ctx.font = 'bold 40px sans-serif';
  const rooms = variant === 0
    ? [['SALA DE REUNIONES', 600, 550], ['OFICINA ABIERTA', 1600, 400], ['ASEOS', 1650, 800], ['ALMACÉN', 400, 1150], ['RECEPCIÓN', 1050, 1150], ['CUARTO TÉCNICO', 1850, 1000]]
    : [['VIVIENDA A', 500, 800], ['SALÓN', 1150, 450], ['COCINA', 1850, 450], ['DORMITORIO 1', 1100, 1050], ['BAÑO', 1600, 1050], ['DORMITORIO 2', 2000, 1050]];
  rooms.forEach(([t, x, y]) => {
    const w = ctx.measureText(t).width;
    ctx.fillText(t, x - w / 2, y);
  });

  // Cajetín
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 4;
  ctx.strokeRect(1500, 1440, 860, 130);
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(variant === 0 ? 'A-101  PLANTA BAJA' : 'A-102  PLANTA PRIMERA', 1530, 1495);
  ctx.font = '26px sans-serif';
  ctx.fillText('Escala 1:100  ·  Proyecto de ejemplo ObraPlan', 1530, 1545);

  const blob = await canvasToBlob(c, 'image/png');
  const thumb = (await resizeImage(blob, 480)).blob;
  return { blob, thumb, width: W, height: H };
}
