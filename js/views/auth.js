import { login, register } from '../sync.js';
import { esc } from '../ui.js';

export function renderAuth(root, { onDone, message = '' }) {
  let mode = 'login';
  const draw = (error = '') => {
    const isLogin = mode === 'login';
    root.innerHTML = `
      <div class="auth">
        <div class="auth-card card">
          <div class="brand auth-brand"><img src="icons/icon.svg" alt="" /> ObraPlan</div>
          <p class="muted">${isLogin ? 'Inicia sesión para acceder a los proyectos de tu equipo.' : 'Crea tu cuenta. Si te han invitado a un proyecto, usa el mismo email.'}</p>
          ${message && !error ? `<p class="auth-note">${esc(message)}</p>` : ''}
          ${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
          <form id="auth-form" novalidate>
            ${isLogin ? '' : '<label class="field"><span>Nombre y apellidos</span><input id="auth-name" name="name" autocomplete="name" required /></label>'}
            <label class="field"><span>Email</span><input id="auth-email" name="email" type="email" autocomplete="email" required /></label>
            <label class="field"><span>Contraseña</span><input id="auth-password" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" minlength="8" required />
              ${isLogin ? '' : '<small class="muted">Mínimo 8 caracteres.</small>'}</label>
            <button class="btn btn-primary btn-block" type="submit">${isLogin ? 'Iniciar sesión' : 'Crear cuenta'}</button>
          </form>
          <p class="center small auth-switch">
            ${isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}
            <button class="link" id="auth-toggle" type="button">${isLogin ? 'Crear una cuenta' : 'Iniciar sesión'}</button>
          </p>
        </div>
      </div>`;
    root.querySelector('#auth-toggle').onclick = () => {
      mode = isLogin ? 'register' : 'login';
      draw();
    };
    const form = root.querySelector('#auth-form');
    form.querySelector('input').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Un momento...';
      try {
        if (isLogin) await login(v.email, v.password);
        else await register(v.name, v.email, v.password);
        onDone();
      } catch (err) {
        const values = { ...v };
        draw(err.status ? err.message : 'No se pudo conectar con el servidor. Revisa tu conexión.');
        for (const [k, val] of Object.entries(values)) if (k !== 'password' && root.querySelector(`[name=${k}]`)) root.querySelector(`[name=${k}]`).value = val;
      }
    };
  };
  draw();
}
