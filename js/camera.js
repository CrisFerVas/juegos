// Cámara integrada en la app: vista previa en directo, disparo, cambio de cámara y varias fotos seguidas.
// Usa getUserMedia (requiere https). Si el navegador o el entorno la bloquean, devuelve null
// para que se ofrezca la cámara del sistema o la galería.

import { esc } from './ui.js';

export const cameraSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.isSecureContext);

/**
 * Abre la cámara a pantalla completa.
 * Devuelve un array de File (vacío si se cancela) o null si no se pudo acceder a la cámara.
 */
export async function openCamera() {
  if (!cameraSupported()) return null;
  let facing = 'environment';
  let stream;
  const start = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
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
    const video = el.querySelector('video');
    video.srcObject = stream;

    const finish = (files) => {
      stream?.getTracks().forEach((t) => t.stop());
      el.remove();
      resolve(files);
    };
    const refresh = () => {
      const n = shots.length;
      el.querySelector('.camera-count').textContent = n ? `${n} foto${n > 1 ? 's' : ''}` : '';
      const done = el.querySelector('[data-cam=done]');
      done.disabled = !n;
      done.textContent = n ? `Listo (${n})` : 'Listo';
      el.querySelector('.camera-thumbs').innerHTML = shots
        .slice(-3)
        .map((s) => `<img src="${esc(s.url)}" alt="" />`)
        .join('');
    };

    el.querySelector('[data-cam=shot]').onclick = async () => {
      if (!video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) return;
      const file = new File([blob], `foto-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' });
      shots.push({ file, url: URL.createObjectURL(blob) });
      const flash = el.querySelector('.camera-flash');
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
      navigator.vibrate?.(20);
      refresh();
    };
    el.querySelector('[data-cam=done]').onclick = () => finish(shots.map((s) => s.file));
    el.querySelector('[data-cam=close]').onclick = () => finish([]);
    el.querySelector('[data-cam=flip]')?.addEventListener('click', async () => {
      facing = facing === 'environment' ? 'user' : 'environment';
      try {
        await start();
        video.srcObject = stream;
      } catch {
        /* se mantiene la cámara actual */
      }
    });
    refresh();
  });
}
