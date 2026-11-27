// Cámara integrada en la app: vista previa en directo, disparo, cambio de cámara y varias fotos seguidas.
// Usa getUserMedia (requiere https). Si el navegador o el entorno la bloquean, devuelve null
// para que se ofrezca la cámara del sistema o la galería.

import { esc, trackOverlay } from './ui.js';

export const cameraSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.isSecureContext);

/**
 * Abre la cámara a pantalla completa.
 * Devuelve un array de File (vacío si se cancela) o null si no se pudo acceder a la cámara.
 */
export async function openCamera() {
  if (!cameraSupported()) return null;
  let facing = 'environment';
  let stream;
  let capture = null; // ImageCapture: foto a la resolución máxima del sensor (Chrome en Android)
  let photoSize = null; // { width, height } máximos para takePhoto
  const start = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    // Vídeo 4:3 (formato del sensor) a la mayor resolución que dé la cámara: se usa si no hay ImageCapture
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    capture = null;
    photoSize = null;
    if ('ImageCapture' in window) {
      try {
        capture = new window.ImageCapture(track);
        const caps = await capture.getPhotoCapabilities();
        if (caps?.imageWidth?.max && caps?.imageHeight?.max) photoSize = { width: caps.imageWidth.max, height: caps.imageHeight.max };
      } catch {
        capture = null;
      }
    }
  };
  try {
    await start();
  } catch {
    return null; // permiso denegado o cámara bloqueada por el entorno
  }

  const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
  const shots = [];

  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'camera';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cámara');
    el.innerHTML = `
      <video class="camera-video" autoplay playsinline muted></video>
      <div class="camera-flash"></div>
      <div class="camera-top">
        <button type="button" class="camera-btn" data-cam="close" aria-label="Cerrar la cámara">✕</button>
        <span class="camera-count" aria-live="polite"></span>
        ${cams.length > 1 ? `<button type="button" class="camera-btn" data-cam="flip" aria-label="Cambiar de cámara">⟲</button>` : '<span></span>'}
      </div>
      <div class="camera-bottom">
        <div class="camera-thumbs"></div>
        <button type="button" class="camera-shutter" data-cam="shot" aria-label="Hacer foto"><span></span></button>
        <button type="button" class="camera-done" data-cam="done" disabled>Listo</button>
      </div>`;
    document.body.appendChild(el);
    // Atrás del móvil: cierra la cámara conservando las fotos ya hechas
    trackOverlay(el, () => finish(shots.map((s) => s.file)));
    const video = el.querySelector('video');
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => refresh());

    const finish = (files) => {
      stream?.getTracks().forEach((t) => t.stop());
      el.remove();
      resolve(files);
    };
    /** Resolución con la que se harán las fotos, p. ej. «12 Mpx». */
    let lastShot = null; // tamaño real de la última foto (el dato más fiable)
    const resolution = () => {
      const area = lastShot ? lastShot.w * lastShot.h : Math.max((photoSize?.width || 0) * (photoSize?.height || 0), video.videoWidth * video.videoHeight);
      if (!area) return '';
      const mp = area / 1e6;
      return `${mp >= 10 ? Math.round(mp) : mp.toLocaleString('es', { maximumFractionDigits: 1 })} Mpx`;
    };
    const refresh = () => {
      const n = shots.length;
      el.querySelector('.camera-count').textContent = [n ? `${n} foto${n > 1 ? 's' : ''}` : '', resolution()].filter(Boolean).join(' · ');
      const done = el.querySelector('[data-cam=done]');
      done.disabled = !n;
      done.textContent = n ? `Listo (${n})` : 'Listo';
      el.querySelector('.camera-thumbs').innerHTML = shots
        .slice(-3)
        .map((s) => `<img src="${esc(s.url)}" alt="" />`)
        .join('');
    };

    let busy = false;
    const shutter = el.querySelector('[data-cam=shot]');
    /** Foto a máxima resolución: ImageCapture (sensor completo) o, si no, un fotograma del vídeo. */
    const takeBlob = async () => {
      if (capture) {
        try {
          const settings = photoSize ? { imageWidth: photoSize.width, imageHeight: photoSize.height } : {};
          const blob = await capture.takePhoto(settings).catch(() => capture.takePhoto());
          if (blob?.size) return blob;
        } catch {
          /* se usa el fotograma del vídeo */
        }
      }
      if (!video.videoWidth) return null;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
      c.width = c.height = 0;
      return blob;
    };

    shutter.onclick = async () => {
      if (busy || !video.videoWidth) return;
      busy = true;
      shutter.classList.add('busy');
      const flash = el.querySelector('.camera-flash');
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
      navigator.vibrate?.(20);
      let blob = null;
      try {
        blob = await takeBlob();
      } finally {
        busy = false;
        shutter.classList.remove('busy');
      }
      if (!blob) return;
      const file = new File([blob], `foto-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' });
      shots.push({ file, url: URL.createObjectURL(blob) });
      refresh();
      createImageBitmap(blob)
        .then((bmp) => {
          lastShot = { w: bmp.width, h: bmp.height };
          bmp.close();
          refresh();
        })
        .catch(() => {});
    };
    el.querySelector('[data-cam=done]').onclick = () => finish(shots.map((s) => s.file));
    el.querySelector('[data-cam=close]').onclick = () => finish([]);
    el.querySelector('[data-cam=flip]')?.addEventListener('click', async () => {
      facing = facing === 'environment' ? 'user' : 'environment';
      try {
        await start();
        video.srcObject = stream;
        lastShot = null;
        refresh();
      } catch {
        /* se mantiene la cámara actual */
      }
    });
    refresh();
  });
}
