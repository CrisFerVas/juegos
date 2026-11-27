// Utilidades de interfaz: escape, modales, avisos, formato de fechas.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(msg, type = 'ok') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

/**
 * Abre un modal. `body` es HTML. Si se pasa `onSubmit`, el cuerpo se envuelve en un <form>
 * y recibe un objeto con los valores del formulario. Devolver `false` mantiene el modal abierto.
 */
export function modal({ title, body, submitLabel = 'Guardar', onSubmit, wide = false, sheet = false, full = false, onOpen }) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''} ${sheet ? 'modal-sheet' : ''} ${full ? 'modal-full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <form class="modal-form" novalidate>
        <header class="modal-head">
          <h2>${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Cerrar">✕</button>
        </header>
        <div class="modal-body">${body}</div>
        ${onSubmit ? `
        <footer class="modal-foot">
          <button type="button" class="btn" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
        </footer>` : ''}
      </form>
    </div>`;
  root.appendChild(wrap);
  const close = () => wrap.remove();
  // En pantallas táctiles, el "clic" que sigue al toque que abrió el diálogo no debe cerrarlo
  const openedAt = performance.now();
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (e.target === wrap && performance.now() - openedAt > 400) close();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  const form = wrap.querySelector('form');
  let busy = false;
  let lastSubmit = -Infinity;
  // Algunos móviles descartan el clic del primer toque tras un trazo (p. ej. al firmar):
  // el botón principal también responde al levantar el dedo, sin ejecutarse dos veces.
  const submitBtn = form.querySelector('[type=submit]');
  let downOnSubmit = false;
  submitBtn?.addEventListener('pointerdown', () => (downOnSubmit = true));
  submitBtn?.addEventListener('pointerleave', () => (downOnSubmit = false));
  submitBtn?.addEventListener('pointerup', () => {
    if (downOnSubmit && !submitBtn.disabled) form.requestSubmit();
    downOnSubmit = false;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit || busy || performance.now() - lastSubmit < 500) return;
    lastSubmit = performance.now();
    const req = [...form.querySelectorAll('[required]')].find((i) => !i.value.trim());
    if (req) {
      req.focus();
      req.classList.add('invalid');
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    busy = true;
    let res;
    try {
      res = await onSubmit(values, form);
    } finally {
      busy = false;
    }
    if (res !== false) close();
  });
  setTimeout(() => form.querySelector('input:not([type=hidden]),textarea,select')?.focus(), 30);
  onOpen?.(wrap, close);
  return { el: wrap, close };
}

export function confirmDialog(message, { okLabel = 'Eliminar', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: 'Confirmar',
      body: `<p>${esc(message)}</p>`,
      submitLabel: okLabel,
      onSubmit: () => {
        answered = true;
        resolve(true);
      },
    });
    if (danger) m.el.querySelector('[type=submit]').classList.add('btn-danger');
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) {
        obs.disconnect();
        if (!answered) resolve(false);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

const dateFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return dateFmt.format(new Date(y, m - 1, d));
}
export const fmtDateTime = (ts) => (ts ? dateTimeFmt.format(new Date(ts)) : '');

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

export function avatar(member, size = 'sm') {
  if (!member) return `<span class="avatar avatar-${size} avatar-empty" title="Sin asignar">–</span>`;
  return `<span class="avatar avatar-${size}" style="background:${esc(member.color)}" title="${esc(member.name)}">${esc(initials(member.name))}</span>`;
}

export function download(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function pickFiles({ accept = '*/*', multiple = false, capture } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    // Si se cierra la cámara o el selector sin elegir nada
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export const MEMBER_COLORS = ['#0f766e', '#7c3aed', '#db2777', '#0369a1', '#b45309', '#15803d', '#be123c', '#4338ca', '#0e7490', '#a16207'];

let userOverride = null;
/** En modo servidor el nombre es el de la cuenta. */
export function setUserOverride(name) {
  userOverride = name;
}

export function userName() {
  if (userOverride) return userOverride;
  try {
    return localStorage.getItem('obraplan.user') || 'Yo';
  } catch {
    return 'Yo';
  }
}
export function setUserName(v) {
  try {
    localStorage.setItem('obraplan.user', v);
  } catch {
    /* almacenamiento no disponible */
  }
}

const ICON_CAMERA = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.8"/></svg>';
const ICON_GALLERY = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>';
export const ICON_PHOTO_PIN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';

/**
 * Menú para elegir el origen de las fotos: cámara del móvil o archivos del dispositivo.
 * Devuelve la lista de archivos elegidos (vacía si se cancela).
 */
export function choosePhotos({ title = 'Añadir fotos' } = {}) {
  return new Promise((resolve) => {
    let chosen = false;
    const onlyImages = (files) => files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    const { el, close } = modal({
      title,
      sheet: true,
      body: `
        <div class="photo-source">
          <button type="button" class="source-btn" data-src="camera">
            ${ICON_CAMERA}<span><strong>Abrir cámara</strong><small>Hacer una foto ahora</small></span>
          </button>
          <button type="button" class="source-btn" data-src="gallery">
            ${ICON_GALLERY}<span><strong>Subir desde el dispositivo</strong><small>Galería o archivos · puedes elegir varias</small></span>
          </button>
        </div>`,
    });
    const pick = (opts) => {
      chosen = true;
      // El selector debe abrirse dentro del mismo toque (requisito de los navegadores móviles)
      const p = pickFiles(opts);
      close();
      p.then((files) => resolve(onlyImages(files)));
    };
    el.querySelector('[data-src=camera]').onclick = async () => {
      chosen = true;
      close();
      // 1) Cámara integrada (vista previa en directo). 2) Si está bloqueada, alternativas.
      const { openCamera } = await import('./camera.js');
      const shots = await openCamera();
      if (shots) return resolve(shots);
      resolve(await cameraFallback());
    };
    el.querySelector('[data-src=gallery]').onclick = () => pick({ accept: 'image/*', multiple: true });
    const obs = new MutationObserver(() => {
      if (!el.isConnected) {
        obs.disconnect();
        if (!chosen) resolve([]);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

/** Cuando la cámara integrada no está disponible: cámara del sistema o galería, con una explicación. */
function cameraFallback() {
  return new Promise((resolve) => {
    let chosen = false;
    const inClaude = /(^|\.)claude\.ai$/.test(location.hostname) || window.top !== window.self;
    const { el, close } = modal({
      title: 'No se pudo abrir la cámara',
      sheet: true,
      body: `
        <p class="muted small">${inClaude
          ? 'Esta vista previa (dentro de Claude) no permite usar la cámara directamente. Prueba una de estas opciones:'
          : 'El navegador no permitió usar la cámara (permiso denegado o no disponible). Prueba una de estas opciones:'}</p>
        <div class="photo-source">
          <button type="button" class="source-btn" data-src="system">
            ${ICON_CAMERA}<span><strong>Usar la cámara del teléfono</strong><small>Abre la app de cámara del sistema</small></span>
          </button>
          <button type="button" class="source-btn" data-src="gallery">
            ${ICON_GALLERY}<span><strong>Elegir de la galería</strong><small>En el menú del sistema suele aparecer también «Hacer foto»</small></span>
          </button>
        </div>
        ${inClaude ? '<p class="muted small">Para usar la cámara integrada, abre la app desde su propia dirección web (por ejemplo, publicada en GitHub Pages).</p>' : '<p class="muted small">Si negaste el permiso, actívalo en los ajustes del navegador para este sitio.</p>'}`,
    });
    const pick = (opts) => {
      chosen = true;
      const p = pickFiles(opts);
      close();
      p.then((files) => resolve(files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name))));
    };
    el.querySelector('[data-src=system]').onclick = () => pick({ accept: 'image/*', capture: 'environment' });
    el.querySelector('[data-src=gallery]').onclick = () => pick({ accept: 'image/*', multiple: true });
    const obs = new MutationObserver(() => {
      if (!el.isConnected) {
        obs.disconnect();
        if (!chosen) resolve([]);
      }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}
