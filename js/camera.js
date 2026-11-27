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
  // Zoom: el de la propia cámara (Chrome en Android) o, si no lo ofrece, zoom digital (recorte)
  const zoom = { hw: false, min: 1, max: 8, value: 1 };
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
    const zc = track.getCapabilities?.().zoom;
    if (zc && zc.max > zc.min) Object.assign(zoom, { hw: true, min: zc.min, max: zc.max, value: track.getSettings?.().zoom || zc.min });
    else Object.assign(zoom, { hw: false, min: 1, max: 8, value: 1 });
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
      <button type="button" class="camera-zoom" data-cam="zoom" aria-label="Zoom de la cámara">1×</button>
      <div class="camera-bottom">
        <div class="camera-thumbs"></div>
        <button type="button" class="camera-shutter" data-cam="shot" aria-label="Hacer foto"><span></span></button>
        <button type="button" class="camera-done" data-cam="done" disabled>Listo</button>
      </div>`;
    document.body.appendChild(el);
    // Mientras la cámara está abierta, el pellizco no debe ampliar la página (el botón de disparar
    // quedaría fuera de la pantalla): se bloquea el zoom de la página y se restablece al cerrar.
    const viewport = document.querySelector('meta[name=viewport]');
    const viewportBefore = viewport?.getAttribute('content');
    viewport?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover');
    const stopPageZoom = (e) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', stopPageZoom, { passive: false });
    el.addEventListener('gesturestart', stopPageZoom); // Safari
    // Atrás del móvil: cierra la cámara conservando las fotos ya hechas
    trackOverlay(el, () => finish(shots.map((s) => s.file)));
    const video = el.querySelector('video');
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => refresh());

    const finish = (files) => {
      stream?.getTracks().forEach((t) => t.stop());
      if (viewport && viewportBefore != null) viewport.setAttribute('content', viewportBefore);
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

    // ---------- Zoom (pellizco o botón 1× / 2× / 5×) ----------
    const zoomBtn = el.querySelector('[data-cam=zoom]');
    let applying = false;
    let wanted = null;
    const pushHwZoom = async () => {
      if (applying) return;
      applying = true;
      while (wanted != null) {
        const v = wanted;
        wanted = null;
        try {
          await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: v }] });
        } catch {
          /* la cámara rechazó el valor */
        }
      }
      applying = false;
    };
    const factor = () => zoom.value / (zoom.min || 1);
    const setZoom = (v) => {
      zoom.value = Math.min(zoom.max, Math.max(zoom.min, v));
      if (zoom.hw) {
        wanted = zoom.value;
        pushHwZoom();
        video.style.transform = '';
      } else video.style.transform = zoom.value > 1 ? `scale(${zoom.value})` : '';
      const f = factor();
      zoomBtn.textContent = `${f < 10 && Math.abs(f - Math.round(f)) > 0.05 ? f.toLocaleString('es', { maximumFractionDigits: 1 }) : Math.round(f)}×`;
      zoomBtn.classList.toggle('on', f > 1.05);
    };
    setZoom(zoom.value);
    zoomBtn.addEventListener('click', () => {
      const f = factor(), m = zoom.min || 1;
      const presets = [1, 2, 5].filter((p) => p * m <= zoom.max + 1e-6);
      const next = presets.find((p) => p > f + 0.05) ?? 1;
      setZoom(next * m);
    });
    // Pellizco con dos dedos sobre la imagen
    const fingers = new Map();
    let pinch = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom.value };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || fingers.size < 2) return;
      const [a, b] = [...fingers.values()];
      setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    });
    const lift = (e) => {
      fingers.delete(e.pointerId);
      if (fingers.size < 2) pinch = null;
    };
    el.addEventListener('pointerup', lift);
    el.addEventListener('pointercancel', lift);

    /** Zoom digital: recorta el centro de la foto según el zoom de la vista previa. */
    const cropDigital = async (blob) => {
      if (zoom.hw || zoom.value <= 1.01) return blob;
      try {
        const bmp = await createImageBitmap(blob);
        const w = Math.round(bmp.width / zoom.value), h = Math.round(bmp.height / zoom.value);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, w, h);
        bmp.close();
        const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
        c.width = c.height = 0;
        return out || blob;
      } catch {
        return blob;
      }
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
        if (blob) blob = await cropDigital(blob);
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
        setZoom(zoom.value);
        refresh();
      } catch {
        /* se mantiene la cámara actual */
      }
    });
    refresh();
  });
}
