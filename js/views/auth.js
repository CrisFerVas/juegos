import { login, register, recover, inviteInfo, acceptInvite } from '../sync.js';
import { esc } from '../ui.js';

const ROLE_NAMES = { admin: 'administrador', miembro: 'miembro', seguidor: 'seguidor (solo lectura)' };

/** Campo de contraseña con botón para mostrarla u ocultarla. */
export function passwordField({ name = 'password', label = 'Contraseña', autocomplete = 'current-password', help = '', id = '' }) {
  return `
    <label class="field"><span>${esc(label)}</span>
      <span class="pw-wrap">
        <input ${id ? `id="${id}"` : ''} name="${name}" type="password" autocomplete="${autocomplete}" ${autocomplete === 'new-password' ? 'minlength="8"' : ''} required />
        <button type="button" class="pw-toggle" data-pw-toggle aria-label="Mostrar contraseña" title="Mostrar contraseña">👁</button>
      </span>
      ${help ? `<small class="muted">${esc(help)}</small>` : ''}
    </label>`;
}
export function bindPasswordToggles(root) {
  root.querySelectorAll('[data-pw-toggle]').forEach((b) => {
    b.onclick = () => {
      const input = b.previousElementSibling;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.classList.toggle('on', show);
      b.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
      b.title = b.getAttribute('aria-label');
    };
  });
}

/**
 * Pantalla de acceso: iniciar sesión, crear cuenta y recuperar la contraseña.
 * Con `invite` (token de un enlace de invitación) muestra el proyecto y da acceso al entrar.
 * `onDone(projectId?)` se llama con la sesión ya iniciada.
 */
export function renderAuth(root, { onDone, message = '', invite = null }) {
  let mode = invite ? 'register' : 'login';
  let info = null; // datos de la invitación
  let inviteError = '';
  const kept = {}; // valores escritos que se conservan al cambiar de modo o tras un error

  const subtitle = {
    login: 'Inicia sesión para acceder a los proyectos de tu equipo.',
    register: 'Crea tu cuenta. Si te han invitado por email, usa ese mismo email.',
    recover: 'Escribe tu email, uno de tus códigos de recuperación (o el código que te dé el administrador del servidor) y la contraseña nueva.',
  };

  const draw = (error = '') => {
    const inviteBox = invite
      ? info
        ? `<p class="auth-invite">Te han invitado a <strong>${esc(info.projectName)}</strong> como <strong>${esc(ROLE_NAMES[info.role] || info.role)}</strong>.
            ${mode === 'login' ? 'Inicia sesión para unirte.' : mode === 'register' ? 'Crea tu cuenta para unirte.' : ''}</p>`
        : inviteError
          ? `<p class="auth-error">${esc(inviteError)}</p>`
          : '<p class="auth-note">Comprobando la invitación...</p>'
      : '';
    const fields = {
      login: `
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" inputmode="email" required /></label>
        ${passwordField({ autocomplete: 'current-password' })}
        <p class="auth-forgot"><button class="link small" type="button" data-mode="recover">¿Olvidaste tu contraseña?</button></p>`,
      register: `
        <label class="field"><span>Nombre y apellidos</span><input name="name" autocomplete="name" required /></label>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" inputmode="email" required /></label>
        ${passwordField({ autocomplete: 'new-password', help: 'Mínimo 8 caracteres.' })}`,
      recover: `
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" inputmode="email" required /></label>
        <label class="field"><span>Código</span><input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" required /></label>
        ${passwordField({ label: 'Contraseña nueva', autocomplete: 'new-password', help: 'Mínimo 8 caracteres. Se cerrará la sesión en tus otros dispositivos.' })}
        <details class="auth-help"><summary>No tengo ningún código</summary>
          <p class="small">Los códigos de recuperación se crean en <strong>Mi cuenta</strong> con la sesión iniciada. Si no los guardaste,
          pide a quien gestiona el servidor de tu empresa un código de restablecimiento
          (<code>npm run admin -- reset-password tu@email</code>). Es válido 24 horas y un solo uso.</p>
        </details>`,
    }[mode];
    const submit = { login: 'Iniciar sesión', register: inviteBox && info ? 'Crear cuenta y unirme' : 'Crear cuenta', recover: 'Cambiar contraseña y entrar' }[mode];
    const switcher = {
      login: '¿No tienes cuenta? <button class="link" type="button" data-mode="register">Crear una cuenta</button>',
      register: '¿Ya tienes cuenta? <button class="link" type="button" data-mode="login">Iniciar sesión</button>',
      recover: '<button class="link" type="button" data-mode="login">‹ Volver a iniciar sesión</button>',
    }[mode];

    root.innerHTML = `
      <div class="auth">
        <div class="auth-card card">
          <div class="brand auth-brand"><img src="icons/icon.svg" alt="" /> ObraPlan</div>
          ${mode === 'recover' ? '<h2 class="auth-title">Recuperar la contraseña</h2>' : ''}
          <p class="muted">${esc(subtitle[mode])}</p>
          ${inviteBox}
          ${message && !error ? `<p class="auth-note">${esc(message)}</p>` : ''}
          ${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
          <form id="auth-form" novalidate>
            ${fields}
            <button class="btn btn-primary btn-block" type="submit">${submit}</button>
          </form>
          <p class="center small auth-switch">${switcher}</p>
        </div>
      </div>`;

    const form = root.querySelector('#auth-form');
    for (const [k, v] of Object.entries(kept)) if (form.elements[k] && k !== 'password') form.elements[k].value = v;
    bindPasswordToggles(root);
    root.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => {
        Object.assign(kept, Object.fromEntries(new FormData(form)));
        mode = b.dataset.mode;
        message = '';
        draw();
      };
    });
    const firstEmpty = [...form.querySelectorAll('input')].find((i) => !i.value) || form.querySelector('input');
    firstEmpty.focus();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const missing = [...form.querySelectorAll('[required]')].find((i) => !i.value.trim());
      if (missing) {
        missing.focus();
        missing.classList.add('invalid');
        return;
      }
      const v = Object.fromEntries(new FormData(form));
      Object.assign(kept, v);
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Un momento...';
      try {
        const okInvite = invite && info ? invite : null;
        let projectId = null;
        if (mode === 'login') {
          await login(v.email, v.password);
          if (okInvite) projectId = (await acceptInvite(okInvite)).project.id;
        } else if (mode === 'register') {
          await register(v.name, v.email, v.password, okInvite);
        } else {
          const r = await recover(v.email, v.code, v.password);
          sessionStorage.setItem('obraplan.recovered', String(r.recoveryCodesLeft ?? ''));
          if (okInvite) projectId = (await acceptInvite(okInvite)).project.id;
        }
        onDone(projectId);
      } catch (err) {
        draw(err.status ? err.message : 'No se pudo conectar con el servidor. Revisa tu conexión.');
      }
    };
  };

  draw();
  if (invite) {
    inviteInfo(invite)
      .then((r) => (info = r))
      .catch((err) => (inviteError = err.status ? err.message : 'No se pudo comprobar la invitación (sin conexión).'))
      .finally(() => {
        const form = root.querySelector('#auth-form');
        if (form) Object.assign(kept, Object.fromEntries(new FormData(form)));
        if (inviteError && mode === 'register') mode = 'login';
        draw();
      });
  }
}
