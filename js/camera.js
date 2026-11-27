// Cámara integrada en la app: vista previa en directo, disparo, cambio de cámara y varias fotos seguidas.
// Usa getUserMedia (requiere https). Si el navegador o el entorno la bloquean, devuelve null
// para que se ofrezca la cámara del sistema o la galería.

import { esc, trackOverlay } from './ui.js';

export const cameraSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.isSecureContext);

// Cámara elegida y resolución máxima de cada cámara del teléfono (se detecta una vez y se recuerda)
const CAM_KEY = 'obraplan.cameraId';
const CAPS_KEY = 'obraplan.cameraCaps';
const load = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* sin almacenamiento */
  }
};
const mpx = (w, h) => {
  const mp = (w * h) / 1e6;
  return `${mp >= 10 ? Math.round(mp) : mp.toLocaleString('es', { maximumFractionDigits: 1 })} Mpx`;
};
/** Orientación de una cámara: por lo detectado o por su nombre. */
const facingOf = (dev, info) => info?.facing || (/front|frontal|user|selfie/i.test(dev.label) ? 'user' : /back|rear|trasera|environment/i.test(dev.label) ? 'environment' : '');

/** Abre una cámara un instante para leer su resolución máxima de foto. */
async function probeCamera(deviceId) {
  const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false });
  const track = s.getVideoTracks()[0];
  const set = track.getSettings?.() || {};
  const vc = track.getCapabilities?.() || {};
  let w = vc.width?.max || set.width || 0, h = vc.height?.max || set.height || 0;
  if ('ImageCapture' in window) {
    try {
      const pc = await new window.ImageCapture(track).getPhotoCapabilities();
      if (pc?.imageWidth?.max * pc?.imageHeight?.max > w * h) [w, h] = [pc.imageWidth.max, pc.imageHeight.max];
    } catch {
      /* sin datos de foto */
    }
  }
  s.getTracks().forEach((t) => t.stop());
  return { facing: set.facingMode || '', w, h };
}

/**
 * Abre la cámara a pantalla completa.
 * Devuelve un array de File (vacío si se cancela) o null si no se pudo acceder a la cámara.
 */
export async function openCamera() {
  if (!cameraSupported()) return null;
  let facing = 'environment';
  let deviceId = load(CAM_KEY, null); // cámara elegida en el menú de resolución
  let stream;
  let capture = null; // ImageCapture: foto a la resolución máxima del sensor (Chrome en Android)
  let photoSize = null; // { width, height } máximos para takePhoto
  let currentId = null; // cámara que se está usando
  // Zoom: el de la propia cámara (Chrome en Android) o, si no lo ofrece, zoom digital (recorte)
  const zoom = { hw: false, min: 1, max: 8, value: 1 };
  const start = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    // Vídeo 4:3 (formato del sensor) a la mayor resolución que dé la cámara: se usa si no hay ImageCapture
    const size = { width: { ideal: 4096 }, height: { ideal: 3072 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: facing }, ...size },
        audio: false,
      });
    } catch (err) {
      if (!deviceId) throw err;
      deviceId = null; // la cámara guardada ya no existe: se usa la trasera por defecto
      save(CAM_KEY, null);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, ...size }, audio: false });
    }
    const track = stream.getVideoTracks()[0];
    const st = track.getSettings?.() || {};
    if (st.facingMode) facing = st.facingMode;
    currentId = st.deviceId || deviceId;
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

  let cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
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
        <button type="button" class="camera-count" data-cam="res" aria-live="polite" aria-haspopup="true" title="Elegir cámara y resolución"></button>
        ${cams.length > 1 ? `<button type="button" class="camera-btn" data-cam="flip" aria-label="Cambiar de cámara">⟲</button>` : '<span></span>'}
      </div>
      <div class="camera-menu hidden" role="menu" aria-label="Cámaras y resolución"></div>
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
    /** Resolución de la cámara actual: la mayor entre la de foto, la máxima de vídeo y la de la última foto. */
    const currentRes = () => {
      const vc = stream?.getVideoTracks()[0]?.getCapabilities?.() || {};
      const opts = [[photoSize?.width, photoSize?.height], [vc.width?.max, vc.height?.max], [video.videoWidth, video.videoHeight], [lastShot?.w, lastShot?.h]];
      return opts.filter(([a, b]) => a && b).sort((a, b) => b[0] * b[1] - a[0] * a[1])[0] || [0, 0];
    };
    const resolution = () => {
      const [rw, rh] = currentRes();
      const area = rw * rh;
      if (!area) return '';
      const mp = area / 1e6;
      return `${mp >= 10 ? Math.round(mp) : mp.toLocaleString('es', { maximumFractionDigits: 1 })} Mpx`;
    };
    const refresh = () => {
      const n = shots.length;
      el.querySelector('.camera-count').textContent = [n ? `${n} foto${n > 1 ? 's' : ''}` : '', resolution()].filter(Boolean).join(' · ') + ' ▾';
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
    const restart = async () => {
      try {
        await start();
      } catch {
        return false;
      }
      video.srcObject = stream;
      lastShot = null;
      setZoom(zoom.value);
      refresh();
      return true;
    };
    el.querySelector('[data-cam=flip]')?.addEventListener('click', async () => {
      facing = facing === 'environment' ? 'user' : 'environment';
      // La mejor cámara conocida del otro lado (o la que elija el navegador)
      const caps = load(CAPS_KEY, {});
      const other = cams
        .filter((d) => facingOf(d, caps[d.deviceId]) === facing)
        .sort((a, b) => (caps[b.deviceId]?.w * caps[b.deviceId]?.h || 0) - (caps[a.deviceId]?.w * caps[a.deviceId]?.h || 0))[0];
      deviceId = other?.deviceId || null;
      save(CAM_KEY, deviceId);
      await restart();
    });

    // ---------- Menú: cámaras del teléfono y su resolución máxima ----------
    const menu = el.querySelector('.camera-menu');
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    const closeMenu = () => menu.classList.add('hidden');
    el.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-cam=res]')) closeMenu();
    });
    /** Resolución de la cámara actual: la de foto (ImageCapture) o la máxima de vídeo. */
    const noteCurrent = (caps) => {
      if (!currentId) return;
      const [w, h] = currentRes();
      if (w && h) caps[currentId] = { ...caps[currentId], facing, w, h };
    };
    const renderMenu = (caps) => {
      const list = cams.map((d) => ({ d, info: caps[d.deviceId], facing: facingOf(d, caps[d.deviceId]) }));
      list.sort((a, b) => (a.facing === 'user') - (b.facing === 'user') || (b.info?.w * b.info?.h || 0) - (a.info?.w * a.info?.h || 0));
      let back = 0;
      const nameOf = (x) => {
        if (x.facing === 'user') return 'Cámara frontal';
        if (x.facing === 'environment') return ++back === 1 ? 'Cámara trasera principal' : `Cámara trasera ${back}`;
        return x.d.label || 'Cámara';
      };
      menu.innerHTML = `<p class="camera-menu-title">Cámara y resolución máxima</p>` + list.map((x) => {
        const on = x.d.deviceId === currentId;
        const res = x.info?.w ? `${mpx(x.info.w, x.info.h)} · ${x.info.w}×${x.info.h}` : 'resolución desconocida';
        return `<button type="button" role="menuitemradio" aria-checked="${on}" class="camera-menu-item ${on ? 'on' : ''}" data-dev="${esc(x.d.deviceId)}">
          <span>${esc(nameOf(x))}</span><small>${esc(res)}</small>${on ? '<b aria-hidden="true">✓</b>' : ''}</button>`;
      }).join('') + (cams.length < 2 ? '<p class="camera-menu-note">El navegador solo muestra esta cámara del teléfono.</p>' : '');
      menu.querySelectorAll('[data-dev]').forEach((b) =>
        b.addEventListener('click', async () => {
          closeMenu();
          if (b.dataset.dev === currentId) return;
          const prev = deviceId;
          deviceId = b.dataset.dev;
          save(CAM_KEY, deviceId);
          if (!(await restart())) {
            deviceId = prev;
            await restart();
          }
        })
      );
    };
    el.querySelector('[data-cam=res]').addEventListener('click', async () => {
      if (!menu.classList.contains('hidden')) return closeMenu();
      // Los nombres de las cámaras solo se conocen tras dar permiso: se vuelven a pedir ahora
      cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput' && d.deviceId);
      const caps = load(CAPS_KEY, {});
      noteCurrent(caps);
      const unknown = cams.filter((d) => !caps[d.deviceId]?.w && d.deviceId !== currentId);
      menu.classList.remove('hidden');
      if (unknown.length) {
        // Hay que abrir cada cámara un momento (el teléfono no deja abrir dos a la vez)
        menu.innerHTML = '<p class="camera-menu-title">Detectando las cámaras del teléfono…</p>';
        stream?.getTracks().forEach((t) => t.stop());
        for (const d of unknown) {
          try {
            caps[d.deviceId] = await probeCamera(d.deviceId);
          } catch {
            /* cámara no disponible */
          }
        }
        await restart();
      }
      noteCurrent(caps);
      save(CAPS_KEY, caps);
      renderMenu(caps);
    });
    refresh();
  });
}
