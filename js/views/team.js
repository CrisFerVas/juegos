import { db, uid, statusOf } from '../db.js';
import { esc, modal, toast, confirmDialog, avatar, initials, fmtDateTime, MEMBER_COLORS } from '../ui.js';
import { session, api, isAdmin, syncNow, ROLE_LABELS } from '../sync.js';

export function renderTeam(view, ctx) {
  ctx.onTaskChanged = null;
  const { members, tasks } = ctx;
  const companies = [...new Set(members.map((m) => m.company).filter(Boolean))];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Equipo</h1><p class="muted">${members.length} persona(s) · ${companies.length} empresa(s)</p></div>
      <div class="actions"><button class="btn btn-primary write" id="add">+ Añadir persona</button></div>
    </div>
    ${members.length === 0 ? `
      <div class="empty"><div class="empty-icon">👷</div><h2>Añade a tu equipo</h2>
      <p class="muted">Jefes de obra, encargados, subcontratas... Podrás asignarles tareas.</p></div>` : `
    <div class="grid cards">
      ${members.map((m) => {
        const mine = tasks.filter((t) => t.assigneeId === m.id);
        const open = mine.filter((t) => statusOf(t.status).open).length;
        return `
        <article class="card member-card">
          ${avatar(m, 'lg')}
          <div class="member-info">
            <strong>${esc(m.name)}</strong>
            <span class="muted small">${esc(m.role || '')}${m.role && m.company ? ' · ' : ''}${esc(m.company || '')}</span>
            ${m.email ? `<a class="small link" href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''}
            ${m.phone ? `<a class="small link" href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ''}
            <span class="small"><strong>${open}</strong> abiertas · ${mine.length} en total</span>
          </div>
          <button class="icon-btn write" data-edit="${m.id}" aria-label="Editar">✎</button>
        </article>`;
      }).join('')}
    </div>`}
    ${session.mode === 'server' ? `
    <section class="card access-card" id="access">
      <h3>Acceso a la aplicación</h3>
      <p class="muted small">Cargando...</p>
    </section>` : ''}`;

  if (session.mode === 'server') renderAccess(view.querySelector('#access'), ctx);
  view.querySelector('#add').addEventListener('click', () => memberForm(ctx));
  view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => memberForm(ctx, ctx.member(b.dataset.edit))));
}

function memberForm(ctx, member) {
  const m = member || { color: MEMBER_COLORS[ctx.members.length % MEMBER_COLORS.length] };
  const { el, close } = modal({
    title: member ? 'Editar persona' : 'Añadir persona',
    body: `
      <label class="field"><span>Nombre *</span><input name="name" required value="${esc(m.name || '')}" /></label>
      <div class="row2">
        <label class="field"><span>Rol</span><input name="role" value="${esc(m.role || '')}" placeholder="Ej. Encargado" /></label>
        <label class="field"><span>Empresa</span><input name="company" value="${esc(m.company || '')}" /></label>
      </div>
      <div class="row2">
        <label class="field"><span>Email</span><input type="email" name="email" value="${esc(m.email || '')}" /></label>
        <label class="field"><span>Teléfono</span><input type="tel" name="phone" value="${esc(m.phone || '')}" /></label>
      </div>
      <div class="field"><span>Color</span>
        <div class="colors">${MEMBER_COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${c === m.color ? 'checked' : ''} /><span style="background:${c}"></span></label>`).join('')}</div>
      </div>
      ${member ? '<hr /><button type="button" class="btn btn-danger btn-sm" id="del">Eliminar del equipo</button>' : ''}`,
    submitLabel: member ? 'Guardar' : 'Añadir',
    onSubmit: async (v) => {
      await db.put('members', {
        ...m,
        id: m.id || uid(),
        projectId: ctx.project.id,
        name: v.name.trim(),
        role: v.role.trim(),
        company: v.company.trim(),
        email: v.email.trim(),
        phone: v.phone.trim(),
        color: v.color || m.color,
        createdAt: m.createdAt || Date.now(),
      });
      toast(member ? 'Cambios guardados' : 'Persona añadida');
      ctx.rerender();
    },
  });
  el.querySelector('#del')?.addEventListener('click', async () => {
    const assigned = ctx.tasks.filter((t) => t.assigneeId === member.id);
    if (!(await confirmDialog(`¿Eliminar a ${member.name}?${assigned.length ? ` Sus ${assigned.length} tarea(s) quedarán sin asignar.` : ''}`))) return;
    for (const t of assigned) {
      t.assigneeId = '';
      await db.put('tasks', t);
    }
    await db.del('members', member.id);
    close();
    toast('Persona eliminada');
    ctx.rerender();
  });
}

// ---------- Accesos (modo servidor) ----------
const roleOptions = (selected) =>
  Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');

async function renderAccess(el, ctx) {
  const pid = ctx.project.id;
  const admin = isAdmin(pid);
  let data;
  try {
    data = await api(`/projects/${pid}/access`);
  } catch (err) {
    el.innerHTML = `<h3>Acceso a la aplicación</h3><p class="muted small">${
      err.status === 404 ? 'El proyecto aún se está subiendo al servidor. Vuelve a intentarlo en unos segundos.' : 'Conéctate a internet para ver y gestionar quién tiene acceso.'
    }</p>`;
    return;
  }
  const appUrl = location.origin + location.pathname;
  el.innerHTML = `
    <h3>Acceso a la aplicación</h3>
    <p class="muted small">Personas con cuenta que pueden abrir este proyecto. <strong>Administrador</strong>: todo, incluidos accesos y ajustes.
      <strong>Miembro</strong>: crea y edita tareas, planos y equipo. <strong>Seguidor</strong>: solo lectura.</p>
    <ul class="access-list">
      ${data.members.map((m) => `
        <li>
          <span class="avatar avatar-sm" style="background:var(--accent)">${esc(initials(m.name))}</span>
          <div class="access-who"><strong>${esc(m.name)}${m.userId === session.user.id ? ' <span class="muted small">(tú)</span>' : ''}</strong><span class="muted small">${esc(m.email)}</span></div>
          ${admin
            ? `<select data-role="${m.userId}" aria-label="Rol de ${esc(m.name)}">${roleOptions(m.role)}</select>
               <button class="icon-btn" data-revoke="${m.userId}" aria-label="Quitar acceso a ${esc(m.name)}" title="Quitar acceso">✕</button>`
            : `<span class="pill">${esc(ROLE_LABELS[m.role])}</span>`}
        </li>`).join('')}
      ${data.invitations.map((i) => `
        <li class="pending">
          <span class="avatar avatar-sm avatar-empty">@</span>
          <div class="access-who"><strong>${esc(i.email)}</strong><span class="muted small">Invitación pendiente · ${esc(ROLE_LABELS[i.role])}</span></div>
          ${admin ? `<button class="icon-btn" data-uninvite="${esc(i.email)}" aria-label="Cancelar invitación" title="Cancelar invitación">✕</button>` : ''}
        </li>`).join('')}
    </ul>
    ${admin ? `
    <form class="invite-form" id="invite-form">
      <input id="invite-email" name="email" type="email" placeholder="email@empresa.com" required aria-label="Email" />
      <select id="invite-role" name="role" aria-label="Rol">${roleOptions('miembro')}</select>
      <button class="btn btn-primary">Dar acceso</button>
    </form>
    <p class="muted small">Si la persona aún no tiene cuenta, recibirá el acceso al registrarse con ese email en
      <code class="copyable" id="app-url" title="Copiar">${esc(appUrl)}</code>. Envíale el enlace por el medio que prefieras.</p>
    <h4 class="access-sub">Enlaces de invitación</h4>
    <p class="muted small">Más fácil: crea un enlace y envíalo por WhatsApp o correo. Quien lo abra crea su cuenta (o entra con la suya)
      y se une al proyecto con el rol elegido. Cualquiera con el enlace puede unirse hasta que caduque o lo anules.</p>
    ${data.links.length ? `
    <ul class="invite-links">
      ${data.links.map((l) => `
        <li>
          <div class="access-who"><strong>${esc(ROLE_LABELS[l.role])}</strong>
            <span class="muted small">Caduca el ${esc(fmtDateTime(l.expires_at))} · ${l.uses ? `usado ${l.uses} ${l.uses === 1 ? 'vez' : 'veces'}` : 'sin usar'}</span></div>
          <button class="btn btn-sm" data-link-copy="${esc(l.token)}">Copiar</button>
          ${navigator.share ? `<button class="btn btn-sm" data-link-share="${esc(l.token)}" data-role-label="${esc(ROLE_LABELS[l.role])}">Compartir…</button>` : ''}
          <button class="icon-btn" data-link-del="${esc(l.token)}" aria-label="Anular enlace" title="Anular enlace">✕</button>
        </li>`).join('')}
    </ul>` : ''}
    <form class="invite-form" id="link-form">
      <select name="role" aria-label="Rol del enlace">${roleOptions('miembro')}</select>
      <select name="days" aria-label="Validez">
        <option value="1">Válido 1 día</option><option value="7" selected>Válido 7 días</option><option value="30">Válido 30 días</option>
      </select>
      <button class="btn">+ Crear enlace</button>
    </form>` : ''}`;

  const refresh = async () => {
    await syncNow();
    renderAccess(el, ctx);
  };
  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
    } catch (err) {
      toast(err.message, 'error');
    }
    refresh();
  };

  el.querySelector('#invite-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!email) return;
    run(async () => {
      const r = await api(`/projects/${pid}/access`, { method: 'POST', body: { email, role: e.target.role.value } });
      toast(r.status === 'added' ? `${email} ya tiene acceso` : `Invitación creada para ${email}`);
    });
  });
  el.querySelectorAll('[data-role]').forEach((sel) =>
    sel.addEventListener('change', () => run(() => api(`/projects/${pid}/access/${sel.dataset.role}`, { method: 'PATCH', body: { role: sel.value } }), 'Rol actualizado'))
  );
  el.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Quitar el acceso a esta persona? Dejará de ver el proyecto.', { okLabel: 'Quitar acceso' }))) return;
      run(() => api(`/projects/${pid}/access/${b.dataset.revoke}`, { method: 'DELETE' }), 'Acceso retirado');
    })
  );
  el.querySelectorAll('[data-uninvite]').forEach((b) =>
    b.addEventListener('click', () => run(() => api(`/projects/${pid}/access/invitations/${encodeURIComponent(b.dataset.uninvite)}`, { method: 'DELETE' }), 'Invitación cancelada'))
  );
  const linkUrl = (token) => `${appUrl}#/invite/${token}`;
  const copyLink = async (token) => {
    try {
      await navigator.clipboard.writeText(linkUrl(token));
      toast('Enlace copiado. Pégalo en WhatsApp o en un correo.');
    } catch {
      prompt('Copia el enlace:', linkUrl(token));
    }
  };
  const shareLink = (token, roleLabel) =>
    navigator
      .share({ title: `Invitación a ${ctx.project.name}`, text: `Te invito al proyecto «${ctx.project.name}» en ObraPlan (${roleLabel}):`, url: linkUrl(token) })
      .catch((err) => err.name !== 'AbortError' && copyLink(token)); // sin permiso para compartir: se copia
  el.querySelector('#link-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const link = await api(`/projects/${pid}/access/links`, { method: 'POST', body: { role: e.target.role.value, days: Number(e.target.days.value) } });
      if (navigator.share) await shareLink(link.token, ROLE_LABELS[link.role]);
      else await copyLink(link.token);
    } catch (err) {
      toast(err.status ? err.message : 'Sin conexión: no se pudo crear el enlace', 'error');
    }
    renderAccess(el, ctx);
  });
  el.querySelectorAll('[data-link-copy]').forEach((b) => b.addEventListener('click', () => copyLink(b.dataset.linkCopy)));
  el.querySelectorAll('[data-link-share]').forEach((b) => b.addEventListener('click', () => shareLink(b.dataset.linkShare, b.dataset.roleLabel)));
  el.querySelectorAll('[data-link-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('¿Anular este enlace? Quien lo tenga ya no podrá unirse con él (quien ya se unió conserva el acceso).', { okLabel: 'Anular' }))) return;
      run(() => api(`/projects/${pid}/access/links/${b.dataset.linkDel}`, { method: 'DELETE' }), 'Enlace anulado');
    })
  );
  el.querySelector('#app-url')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(appUrl);
      toast('Enlace copiado');
    } catch {
      getSelection().selectAllChildren(e.target);
    }
  });
}
