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
export function modal({ title, body, submitLabel = 'Guardar', onSubmit, wide = false, onOpen }) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
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
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
  const form = wrap.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const req = [...form.querySelectorAll('[required]')].find((i) => !i.value.trim());
    if (req) {
      req.focus();
      req.classList.add('invalid');
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const res = await onSubmit(values, form);
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
