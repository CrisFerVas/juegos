// Reducción de videos antes de guardarlos: como máximo 720p (1280×720, en vertical 720×1280) y 30 fps.
// Se reproduce el video sin sonido por los altavoces, se dibuja cada fotograma en un lienzo del tamaño
// reducido y se graba con MediaRecorder (imagen del lienzo a 30 fps + audio original por Web Audio).
// La conversión tarda lo mismo que dura el video.

export const MAX_LONG = 1280;
export const MAX_SHORT = 720;
export const FPS = 30;
const VIDEO_BITRATE = 2_500_000; // ≈ 19 MB por minuto
const AUDIO_BITRATE = 96_000;
// Un video ya pequeño (≤ 720p y con poco peso por segundo) se guarda tal cual
const KEEP_BELOW_BPS = 3_500_000;

export const isVideo = (file) => (file?.type || '').startsWith('video/') || /\.(mp4|mov|webm|mkv|3gp|m4v)$/i.test(file?.name || '');

/** Formato de grabación: MP4 si el navegador lo admite (se abre en cualquier sitio); si no, WebM. */
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const opts = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}
export const canCompressVideo = () => !!pickMime() && !!HTMLCanvasElement.prototype.captureStream;

/** Lee tamaño y duración de un video. */
export function videoInfo(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0 });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer el video'));
    };
    v.src = url;
  });
}

/** Tamaño de salida (pares, como piden los codificadores) para que quepa en 720p. */
export function targetSize(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const k = Math.min(1, MAX_LONG / long, MAX_SHORT / short);
  const even = (n) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w), height: even(h), scaled: k < 1 };
}

/** ¿Hace falta reducirlo? */
export async function needsCompression(file) {
  const info = await videoInfo(file);
  const { scaled } = targetSize(info.width, info.height);
  const bps = info.duration ? (file.size * 8) / info.duration : Infinity;
  return { ...info, needed: scaled || bps > KEEP_BELOW_BPS };
}

/**
 * Reduce un video a 720p / 30 fps. `onProgress(0..1)`. `signal` (AbortSignal) permite cancelarlo.
 * Devuelve un File nuevo (o lanza un error si el navegador no puede).
 */
export async function compressVideo(file, { onProgress = () => {}, signal } = {}) {
  const mime = pickMime();
  if (!mime || !HTMLCanvasElement.prototype.captureStream) throw new Error('Este navegador no puede reducir videos');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error('No se pudo leer el video'));
  });
  const { width, height } = targetSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  const stream = canvas.captureStream(FPS);

  // Sonido: del video a la grabación, sin pasar por los altavoces
  let audioCtx = null;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  } catch {
    video.muted = true; // sin audio si no se puede capturar
  }

  // La pantalla no debe apagarse mientras se convierte (el navegador pararía el video)
  let wake = null;
  try {
    wake = await navigator.wakeLock?.request('screen');
  } catch {
    /* sin bloqueo de pantalla */
  }

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => (rec.onstop = res));

  let running = true;
  const draw = () => {
    if (!running) return;
    g.drawImage(video, 0, 0, width, height);
    if (video.duration) onProgress(Math.min(1, video.currentTime / video.duration));
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  const cleanup = () => {
    running = false;
    video.pause();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
    wake?.release().catch(() => {});
    URL.revokeObjectURL(url);
  };

  try {
    const ended = new Promise((res, rej) => {
      video.onended = res;
      video.onerror = () => rej(new Error('Error al reproducir el video'));
      signal?.addEventListener('abort', () => rej(new DOMException('Cancelado', 'AbortError')));
    });
    g.drawImage(video, 0, 0, width, height);
    rec.start(1000);
    await audioCtx?.resume().catch(() => {});
    await video.play();
    draw();
    await ended;
    onProgress(1);
    rec.stop();
    await stopped;
  } catch (err) {
    if (rec.state !== 'inactive') rec.stop();
    cleanup();
    throw err;
  }
  cleanup();
  const type = mime.split(';')[0];
  const ext = type === 'video/mp4' ? 'mp4' : 'webm';
  const name = `${file.name.replace(/\.[^.]+$/, '') || 'video'}-720p.${ext}`;
  return new File(chunks, name, { type });
}
