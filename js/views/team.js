import { db, uid, statusOf } from '../db.js';
import { esc, modal, toast, confirmDialog, avatar, MEMBER_COLORS } from '../ui.js';

export function renderTeam(view, ctx) {
  ctx.onTaskChanged = null;
  const { members, tasks } = ctx;
  const companies = [...new Set(members.map((m) => m.company).filter(Boolean))];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Equipo</h1><p class="muted">${members.length} persona(s) · ${companies.length} empresa(s)</p></div>
      <div class="actions"><button class="btn btn-primary" id="add">+ Añadir persona</button></div>
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
          <button class="icon-btn" data-edit="${m.id}" aria-label="Editar">✎</button>
        </article>`;
      }).join('')}
    </div>`}`;

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
