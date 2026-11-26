import { db, exportProject, deleteProject } from '../db.js';
import { esc, toast, confirmDialog, download, userName, setUserName } from '../ui.js';

export function renderSettings(view, ctx) {
  ctx.onTaskChanged = null;
  const p = ctx.project;
  view.innerHTML = `
    <div class="page-head"><div><h1>Ajustes</h1><p class="muted">Configuración del proyecto y copia de seguridad.</p></div></div>

    <div class="grid settings-grid">
      <form class="card" id="project-form">
        <h3>Datos del proyecto</h3>
        <label class="field"><span>Nombre *</span><input name="name" required value="${esc(p.name)}" /></label>
        <div class="row2">
          <label class="field"><span>Código</span><input name="code" value="${esc(p.code)}" /></label>
          <label class="field"><span>Cliente</span><input name="client" value="${esc(p.client)}" /></label>
        </div>
        <label class="field"><span>Dirección</span><input name="address" value="${esc(p.address)}" /></label>
        <button class="btn btn-primary">Guardar</button>
      </form>

      <form class="card" id="cat-form">
        <h3>Categorías de tareas</h3>
        <p class="muted small">Una por línea. Se usan para clasificar tareas (oficios, especialidades...).</p>
        <textarea name="categories" rows="8">${esc(p.categories.join('\n'))}</textarea>
        <button class="btn btn-primary">Guardar categorías</button>
      </form>

      <form class="card" id="user-form">
        <h3>Tu nombre</h3>
        <p class="muted small">Aparece en comentarios y en el historial de cambios.</p>
        <input name="user" value="${esc(userName())}" />
        <button class="btn btn-primary">Guardar</button>
      </form>

      <section class="card">
        <h3>Copia de seguridad</h3>
        <p class="muted small">Los datos se guardan en este navegador. Exporta el proyecto (incluye planos y fotos) para guardarlo o compartirlo; se importa desde la pantalla de proyectos.</p>
        <button class="btn" id="export">⇩ Exportar proyecto (.json)</button>
        <hr />
        <h3 class="text-danger">Zona peligrosa</h3>
        <button class="btn btn-danger" id="delete">Eliminar proyecto</button>
      </section>
    </div>`;

  view.querySelector('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    if (!v.name.trim()) return toast('El nombre es obligatorio', 'error');
    Object.assign(p, { name: v.name.trim(), code: v.code.trim(), client: v.client.trim(), address: v.address.trim(), updatedAt: Date.now() });
    await db.put('projects', p);
    toast('Proyecto actualizado');
    ctx.rerender();
  });
  view.querySelector('#cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cats = [...new Set(e.target.categories.value.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (!cats.length) return toast('Añade al menos una categoría', 'error');
    p.categories = cats;
    await db.put('projects', p);
    toast('Categorías guardadas');
  });
  view.querySelector('#user-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.user.value.trim();
    if (!v) return;
    setUserName(v);
    toast('Nombre guardado');
  });
  view.querySelector('#export').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Exportando...';
    try {
      const data = await exportProject(p.id);
      const name = p.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
      download(`obraplan-${name}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
      toast('Proyecto exportado');
    } finally {
      e.target.disabled = false;
      e.target.textContent = '⇩ Exportar proyecto (.json)';
    }
  });
  view.querySelector('#delete').addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar "${p.name}" con todos sus planos, tareas y fotos? No se puede deshacer.`))) return;
    await deleteProject(p.id);
    toast('Proyecto eliminado');
    location.hash = '#/';
  });
}
