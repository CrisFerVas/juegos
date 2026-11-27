// Mi cuenta: perfil, email, contraseña, códigos de recuperación, dispositivos con sesión abierta y baja.
import { esc, toast, modal, confirmDialog, download, fmtDateTime, userName, setUserName, initials } from '../ui.js';
import { session, api, logout, updateAccount, forgetSession } from '../sync.js';
import { passwordField, bindPasswordToggles } from './auth.js';

const dateFmt = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });

function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 2) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : d < 30 ? `hace ${d} días` : fmtDateTime(ts);
}

/** Modal con formulario que llama a la API y muestra el error dentro, sin cerrarse. */
function formModal({ title, body, submitLabel, danger = false, action }) {
  const m = modal({
    title,
    body: `${body}<p class="auth-error" data-err hidden></p>`,
    submitLabel,
    onSubmit: async (v, form) => {
      const err = form.querySelector('[data-err]');
      const btn = form.querySelector('[type=submit]');
      err.hidden = true;
      btn.disabled = true;
      try {
        return await action(v, m);
      } catch (e) {
        err.textContent = e.status ? e.message : 'Sin conexión. Inténtalo de nuevo cuando tengas internet.';
        err.hidden = false;
        return false;
      } finally {
        btn.disabled = false;
      }
    },
  });
  bindPasswordToggles(m.el);
  if (danger) m.el.querySelector('[type=submit]').classList.add('btn-danger');
  return m;
}

export async function renderAccount(view) {
  if (session.mode !== 'server') return renderLocal(view);
  const u = session.user;
  view.innerHTML = `
    <div class="page-head"><div><a href="#/" class="muted small">← Proyectos</a><h1>Mi cuenta</h1></div></div>
    <div class="grid settings-grid">
      <section class="card account-profile">
        <div class="account-head">
          <span class="avatar avatar-lg" style="background:var(--accent)">${esc(initials(u.name))}</span>
          <div><strong id="acc-name">${esc(u.name)}</strong><br /><span class="muted small" id="acc-email">${esc(u.email)}</span>
            ${u.createdAt ? `<br /><span class="muted small">Cuenta creada el ${dateFmt.format(new Date(u.createdAt))}</span>` : ''}</div>
        </div>
        <form id="name-form" class="inline-form">
          <label class="field"><span>Nombre</span><input name="name" value="${esc(u.name)}" autocomplete="name" required /></label>
          <button class="btn btn-primary">Guardar</button>
        </form>
        <p class="muted small">Tu nombre aparece en comentarios, partes y el historial de cambios.</p>
        <div class="btn-row">
          <button class="btn" id="change-email" type="button">Cambiar email</button>
          <button class="btn" id="change-password" type="button">Cambiar contraseña</button>
        </div>
      </section>

      <section class="card" id="recovery-card">
        <h3>Códigos de recuperación</h3>
        <p class="muted small">Sirven para entrar si olvidas la contraseña (en «¿Olvidaste tu contraseña?»). Cada código vale una vez.
          Guárdalos fuera del teléfono: en una nota, un correo a ti mismo o impresos.</p>
        <p id="recovery-status" class="small">…</p>
        <button class="btn" id="make-codes" type="button">Crear códigos</button>
      </section>

      <section class="card" id="sessions-card">
        <h3>Dispositivos con la sesión abierta</h3>
        <div id="sessions-body"><p class="muted small">Cargando...</p></div>
      </section>

      <section class="card">
        <h3>Sesión</h3>
        <p class="muted small">Al cerrar la sesión, los cambios que aún no se hayan enviado se quedan en este dispositivo y se envían cuando vuelvas a entrar con la misma cuenta.</p>
        <button class="btn" id="logout" type="button">Cerrar sesión</button>
        <hr />
        <h3 class="text-danger">Eliminar la cuenta</h3>
        <p class="muted small" id="delete-help">Se borra tu cuenta y pierdes el acceso a todos los proyectos. Los proyectos en los que solo estás tú se eliminan del servidor.</p>
        <button class="btn btn-danger" id="delete-account" type="button">Eliminar mi cuenta</button>
      </section>
    </div>`;

  let me = null;
  const loadMe = async () => {
    try {
      me = await api('/me');
      updateAccount(me.user, me.projects);
      const n = me.recoveryCodesLeft;
      view.querySelector('#recovery-status').innerHTML = n
        ? `Te quedan <strong>${n}</strong> código(s) sin usar.${n <= 2 ? ' <span class="text-danger">Crea unos nuevos pronto.</span>' : ''}`
        : '<span class="text-danger">Aún no tienes códigos.</span> Si olvidas la contraseña, solo podrá ayudarte quien gestiona el servidor.';
      view.querySelector('#make-codes').textContent = n ? 'Crear códigos nuevos' : 'Crear códigos';
    } catch (err) {
      view.querySelector('#recovery-status').textContent = err.status ? err.message : 'Sin conexión: conéctate a internet para gestionar tu cuenta.';
    }
  };
  loadMe();
  loadSessions(view.querySelector('#sessions-body'));

  view.querySelector('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return e.target.name.focus();
    try {
      const r = await api('/me', { method: 'PATCH', body: { name } });
      updateAccount(r.user);
      view.querySelector('#acc-name').textContent = r.user.name;
      document.querySelectorAll('.user-name').forEach((el) => (el.textContent = r.user.name));
      toast('Nombre guardado');
    } catch (err) {
      toast(err.status ? err.message : 'Sin conexión: no se pudo guardar', 'error');
    }
  });

  view.querySelector('#change-email').addEventListener('click', () =>
    formModal({
      title: 'Cambiar email',
      body: `
        <p class="muted small">Email actual: <strong>${esc(session.user.email)}</strong>. Usarás el nuevo para iniciar sesión.</p>
        <label class="field"><span>Email nuevo</span><input name="email" type="email" inputmode="email" autocomplete="email" required /></label>
        ${passwordField({ label: 'Tu contraseña (para confirmar)' })}`,
      submitLabel: 'Cambiar email',
      action: async (v) => {
        const r = await api('/me/email', { method: 'POST', body: { email: v.email.trim(), password: v.password } });
        updateAccount(r.user, r.projects);
        view.querySelector('#acc-email').textContent = r.user.email;
        toast('Email actualizado');
      },
    })
  );

  view.querySelector('#change-password').addEventListener('click', () =>
    formModal({
      title: 'Cambiar contraseña',
      body: `
        ${passwordField({ name: 'current', label: 'Contraseña actual' })}
        ${passwordField({ label: 'Contraseña nueva', autocomplete: 'new-password', help: 'Mínimo 8 caracteres.' })}
        ${passwordField({ name: 'repeat', label: 'Repite la contraseña nueva', autocomplete: 'new-password' })}
        <p class="muted small">Se cerrará la sesión en tus otros dispositivos.</p>`,
      submitLabel: 'Cambiar contraseña',
      action: async (v) => {
        if (v.password !== v.repeat) throw Object.assign(new Error('Las contraseñas nuevas no coinciden'), { status: 400 });
        await api('/me/password', { method: 'POST', body: { current: v.current, password: v.password } });
        toast('Contraseña cambiada');
        loadSessions(view.querySelector('#sessions-body'));
      },
    })
  );

  view.querySelector('#make-codes').addEventListener('click', () =>
    formModal({
      title: 'Crear códigos de recuperación',
      body: `
        <p class="small">Se crearán 8 códigos nuevos${me?.recoveryCodesLeft ? ' y <strong>los anteriores dejarán de valer</strong>' : ''}.</p>
        ${passwordField({ label: 'Tu contraseña (para confirmar)' })}`,
      submitLabel: 'Crear códigos',
      action: async (v) => {
        const { codes } = await api('/me/recovery-codes', { method: 'POST', body: { password: v.password } });
        setTimeout(() => showCodes(codes), 50);
        loadMe();
      },
    })
  );

  view.querySelector('#logout').addEventListener('click', () => logout());

  view.querySelector('#delete-account').addEventListener('click', () => {
    formModal({
      title: 'Eliminar mi cuenta',
      body: `
        <p class="small">Esto <strong>no se puede deshacer</strong>. Perderás el acceso a todos tus proyectos; los que solo usas tú se eliminarán del servidor
          (exporta antes una copia desde Ajustes si la quieres).</p>
        ${me?.blockingProjects?.length ? `<p class="auth-error">Eres el único administrador de: <strong>${esc(me.blockingProjects.join(', '))}</strong>.
          Dale el rol de administrador a otra persona (Equipo › Acceso a la aplicación) o elimina el proyecto primero.</p>` : ''}
        ${passwordField({ label: 'Tu contraseña (para confirmar)' })}`,
      submitLabel: 'Eliminar cuenta',
      danger: true,
      action: async (v) => {
        await api('/me', { method: 'DELETE', body: { password: v.password } });
        toast('Cuenta eliminada');
        setTimeout(forgetSession, 600);
      },
    });
  });
}

function showCodes(codes) {
  const text = `Códigos de recuperación de ObraPlan\n${session.user.email}\nCreados el ${dateFmt.format(new Date())}\n\nCada código vale una sola vez.\n\n${codes.join('\n')}\n`;
  const { el } = modal({
    title: 'Guarda tus códigos',
    body: `
      <p class="small">Es la <strong>única vez</strong> que se muestran. Guárdalos en un lugar seguro fuera de este teléfono.</p>
      <ol class="codes-list">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ol>
      <div class="btn-row">
        <button type="button" class="btn" id="codes-copy">Copiar</button>
        <button type="button" class="btn" id="codes-download">Descargar .txt</button>
        ${navigator.share ? '<button type="button" class="btn" id="codes-share">Compartir…</button>' : ''}
      </div>`,
    submitLabel: 'Ya los he guardado',
    onSubmit: () => {},
  });
  el.querySelector('#codes-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Códigos copiados');
    } catch {
      getSelection().selectAllChildren(el.querySelector('.codes-list'));
    }
  };
  el.querySelector('#codes-download').onclick = () => download('obraplan-codigos-recuperacion.txt', text, 'text/plain');
  el.querySelector('#codes-share')?.addEventListener('click', () => navigator.share({ title: 'Códigos de recuperación de ObraPlan', text }).catch(() => {}));
}

async function loadSessions(el) {
  let list;
  try {
    list = (await api('/me/sessions')).sessions;
  } catch (err) {
    el.innerHTML = `<p class="muted small">${err.status ? esc(err.message) : 'Sin conexión: conéctate a internet para ver tus dispositivos.'}</p>`;
    return;
  }
  const others = list.filter((s) => !s.current);
  el.innerHTML = `
    <ul class="access-list session-list">
      ${list.map((s) => `
        <li>
          <span class="session-icon" aria-hidden="true">${/Android|iPhone/.test(s.device) ? '📱' : /iPad/.test(s.device) ? '📲' : '💻'}</span>
          <div class="access-who"><strong>${esc(s.device)}${s.current ? ' <span class="pill">Este dispositivo</span>' : ''}</strong>
            <span class="muted small">Último uso: ${s.current ? 'ahora' : esc(ago(s.lastSeen))} · desde ${esc(fmtDateTime(s.createdAt))}</span></div>
          ${s.current ? '' : `<button class="btn btn-sm" data-close-session="${esc(s.id)}">Cerrar</button>`}
        </li>`).join('')}
    </ul>
    ${others.length ? '<button class="btn" id="close-others" type="button">Cerrar sesión en los demás dispositivos</button>' : '<p class="muted small">Solo tienes la sesión abierta en este dispositivo.</p>'}
    <p class="muted small">Si ves un dispositivo que no reconoces, ciérralo y cambia la contraseña.</p>`;
  el.querySelectorAll('[data-close-session]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/me/sessions/${b.dataset.closeSession}`, { method: 'DELETE' });
        toast('Sesión cerrada en ese dispositivo');
      } catch (err) {
        toast(err.status ? err.message : 'Sin conexión', 'error');
      }
      loadSessions(el);
    })
  );
  el.querySelector('#close-others')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Cerrar la sesión en ${others.length} dispositivo(s)? Tendrán que volver a iniciar sesión.`, { okLabel: 'Cerrar sesiones' }))) return;
    try {
      await api('/me/sessions/others', { method: 'DELETE' });
      toast('Sesiones cerradas');
    } catch (err) {
      toast(err.status ? err.message : 'Sin conexión', 'error');
    }
    loadSessions(el);
  });
}

/** Sin servidor no hay cuentas: solo el nombre que firma los cambios en este navegador. */
function renderLocal(view) {
  view.innerHTML = `
    <div class="page-head"><div><a href="#/" class="muted small">← Proyectos</a><h1>Mi cuenta</h1></div></div>
    <div class="grid settings-grid">
      <form class="card" id="user-form">
        <h3>Tu nombre</h3>
        <p class="muted small">Aparece en comentarios y en el historial de cambios.</p>
        <input name="user" value="${esc(userName())}" />
        <button class="btn btn-primary">Guardar</button>
      </form>
      <section class="card">
        <h3>Modo local</h3>
        <p class="muted small">Esta copia de la app funciona sin servidor: no hay cuentas ni contraseñas y los datos se guardan solo en este navegador.
          Para trabajar en equipo con cuentas, accesos por proyecto y sincronización entre dispositivos hay que publicar el servidor de ObraPlan.</p>
      </section>
    </div>`;
  view.querySelector('#user-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.user.value.trim();
    if (!v) return;
    setUserName(v);
    toast('Nombre guardado');
  });
}
