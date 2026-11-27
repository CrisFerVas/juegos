import { db, exportProject, deleteProject } from '../db.js';
import { esc, toast, confirmDialog, download, userName, setUserName } from '../ui.js';
import { session, isAdmin, logout } from '../sync.js';
import { photoQuality, setPhotoQuality } from '../media.js';

export function renderSettings(view, ctx) {
  ctx.onTaskChanged = null;
  const p = ctx.project;
  const admin = isAdmin(p.id);
  const server = session.mode === 'server';
  const lock = admin ? '' : 'disabled';
  const adminNote = admin ? '' : '<p class="muted small">Solo los administradores pueden cambiar esto.</p>';
  view.innerHTML = `
    <div class="page-head"><div><h1>Ajustes</h1><p class="muted">Configuración del proyecto y copia de seguridad.</p></div></div>

    <div class="grid settings-grid">
      <form class="card" id="project-form">
        <h3>Datos del proyecto</h3>
        ${adminNote}
        <fieldset class="plain" ${lock}>
        <label class="field"><span>Nombre *</span><input name="name" required value="${esc(p.name)}" /></label>
        <div class="row2">
          <label class="field"><span>Código</span><input name="code" value="${esc(p.code)}" /></label>
          <label class="field"><span>Cliente</span><input name="client" value="${esc(p.client)}" /></label>
        </div>
        <label class="field"><span>Dirección</span><input name="address" value="${esc(p.address)}" /></label>
        <button class="btn btn-primary">Guardar</button>
        </fieldset>
      </form>

      <form class="card" id="cat-form">
        <h3>Categorías de tareas</h3>
        <p class="muted small">Una por línea. Se usan para clasificar tareas (oficios, especialidades...).</p>
        ${adminNote}
        <fieldset class="plain" ${lock}>
        <textarea name="categories" rows="8">${esc(p.categories.join('\n'))}</textarea>
        <button class="btn btn-primary">Guardar categorías</button>
        </fieldset>
      </form>

      ${server ? `
      <section class="card">
        <h3>Tu cuenta</h3>
        <p><strong>${esc(session.user.name)}</strong><br /><span class="muted small">${esc(session.user.email)}</span></p>
        <p class="muted small">Tu nombre aparece en comentarios y en el historial de cambios.</p>
        <button class="btn" id="logout" type="button">Cerrar sesión</button>
      </section>` : `
      <form class="card" id="user-form">
        <h3>Tu nombre</h3>
        <p class="muted small">Aparece en comentarios y en el historial de cambios.</p>
        <input name="user" value="${esc(userName())}" />
        <button class="btn btn-primary">Guardar</button>
      </form>`}

      <section class="card" id="photo-quality">
        <h3>Calidad de las fotos</h3>
        <p class="muted small">Se aplica a las fotos que hagas o subas desde este dispositivo.</p>
        <div class="seg-choice" role="group" aria-label="Calidad de las fotos">
          <button type="button" data-q="original" class="${photoQuality() === 'original' ? 'on' : ''}">Original</button>
          <button type="button" data-q="optimized" class="${photoQuality() === 'optimized' ? 'on' : ''}">Optimizada</button>
        </div>
        <p class="muted small" id="photo-quality-help"></p>
      </section>

      <section class="card">
        <h3>Copia de seguridad</h3>
        <p class="muted small">Los datos se guardan en este navegador. Exporta el proyecto (incluye planos y fotos) para guardarlo o compartirlo; se importa desde la pantalla de proyectos.</p>
        <button class="btn" id="export">⇩ Exportar proyecto (.json)</button>
        <hr />
        ${admin ? `
        <h3 class="text-danger">Zona peligrosa</h3>
        <p class="muted small">${server ? 'Se eliminará para todas las personas con acceso.' : ''}</p>
        <button class="btn btn-danger" id="delete">Eliminar proyecto</button>` : ''}
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
  view.querySelector('#logout')?.addEventListener('click', () => logout());
  view.querySelector('#user-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.user.value.trim();
    if (!v) return;
    setUserName(v);
    toast('Nombre guardado');
  });
  const qCard = view.querySelector('#photo-quality');
  const qHelp = () => {
    qCard.querySelector('#photo-quality-help').textContent = photoQuality() === 'original'
      ? 'Máxima resolución de la cámara del dispositivo, sin recomprimir (≈ 3-10 MB por foto). Ideal para ver detalles.'
      : 'Fotos reducidas a 2560 px (≈ 0,5-1 MB por foto). Sincronizan más rápido con datos móviles.';
  };
  qHelp();
  qCard.querySelectorAll('[data-q]').forEach((b) =>
    b.addEventListener('click', () => {
      setPhotoQuality(b.dataset.q);
      qCard.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b));
      qHelp();
      toast(b.dataset.q === 'original' ? 'Fotos en calidad original' : 'Fotos optimizadas');
    })
  );

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
  view.querySelector('#delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`¿Eliminar "${p.name}" con todos sus planos, tareas y fotos? No se puede deshacer.`))) return;
    await deleteProject(p.id);
    toast('Proyecto eliminado');
    location.hash = '#/';
  });
}
