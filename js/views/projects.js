import { db, createProject, createTask, saveFile, importProject, uid, statusOf } from '../db.js';
import { esc, modal, toast, pickFiles, fmtDateTime, MEMBER_COLORS } from '../ui.js';
import { demoFloorPlan } from '../media.js';
import { session, roleOf, ROLE_LABELS } from '../sync.js';

export async function renderProjects(view) {
  const [projects, tasks] = await Promise.all([db.all('projects'), db.all('tasks')]);
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  const stats = (pid) => {
    const t = tasks.filter((x) => x.projectId === pid);
    return { total: t.length, open: t.filter((x) => statusOf(x.status).open).length };
  };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Proyectos</h1>
        <p class="muted">Gestiona planos, tareas y equipos de tus obras.</p>
      </div>
      <div class="actions">
        <button class="btn" id="import">Importar copia</button>
        <button class="btn btn-primary" id="new">+ Nuevo proyecto</button>
      </div>
    </div>
    ${projects.length === 0 ? `
      <div class="empty">
        <div class="empty-icon">🏗️</div>
        <h2>Aún no tienes proyectos</h2>
        <p class="muted">Crea tu primer proyecto o carga uno de ejemplo para explorar la aplicación.</p>
        <div class="actions center">
          <button class="btn" id="demo">Cargar proyecto de ejemplo</button>
          <button class="btn btn-primary" id="new2">+ Nuevo proyecto</button>
        </div>
      </div>` : `
      <div class="grid cards">
        ${projects.map((p) => {
          const s = stats(p.id);
          return `
          <a class="card project-card" href="#/p/${p.id}/dashboard">
            <div class="project-card-top">
              <span class="project-badge">${esc((p.code || p.name).slice(0, 3).toUpperCase())}</span>
              <div>
                <h3>${esc(p.name)}</h3>
                <p class="muted small">${esc(p.address || 'Sin dirección')}</p>
              </div>
            </div>
            <div class="project-card-stats">
              <span><strong>${s.open}</strong> abiertas</span>
              <span><strong>${s.total}</strong> tareas</span>
            </div>
            <p class="muted small">Actualizado ${esc(fmtDateTime(p.updatedAt))}${session.mode === 'server' ? ` · <span class="pill">${esc(ROLE_LABELS[roleOf(p.id)].split(' ')[0])}</span>` : ''}</p>
          </a>`;
        }).join('')}
      </div>
      <p class="muted small center" style="margin-top:24px">
        <button class="link" id="demo">Cargar proyecto de ejemplo</button>
      </p>`}
  `;

  const openNew = () => projectForm();
  view.querySelector('#new')?.addEventListener('click', openNew);
  view.querySelector('#new2')?.addEventListener('click', openNew);
  view.querySelector('#demo')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const p = await seedDemo();
    toast('Proyecto de ejemplo creado');
    location.hash = `#/p/${p.id}/dashboard`;
  });
  view.querySelector('#import').addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: '.json,application/json' });
    if (!file) return;
    try {
      const p = await importProject(JSON.parse(await file.text()));
      toast('Proyecto importado');
      location.hash = `#/p/${p.id}/dashboard`;
    } catch (err) {
      toast(err.message || 'No se pudo importar', 'error');
    }
  });
}

function projectForm() {
  modal({
    title: 'Nuevo proyecto',
    body: `
      <label class="field"><span>Nombre del proyecto *</span><input name="name" required placeholder="Ej. Edificio Residencial Las Palmas" /></label>
      <div class="row2">
        <label class="field"><span>Código</span><input name="code" placeholder="Ej. LP-2026" /></label>
        <label class="field"><span>Cliente</span><input name="client" /></label>
      </div>
      <label class="field"><span>Dirección</span><input name="address" /></label>`,
    submitLabel: 'Crear proyecto',
    onSubmit: async (v) => {
      const p = await createProject(v);
      location.hash = `#/p/${p.id}/dashboard`;
    },
  });
}

async function seedDemo() {
  const project = await createProject({
    name: 'Oficinas Centro Norte',
    code: 'OCN-26',
    address: 'Av. de la Construcción 123',
    client: 'Inmobiliaria Ejemplo S.A.',
  });
  const pid = project.id;

  const people = [
    ['Laura Gómez', 'Jefa de obra', 'Constructora Principal'],
    ['Carlos Ruiz', 'Encargado', 'Constructora Principal'],
    ['Marta Díaz', 'Electricista', 'Instalaciones Voltio'],
    ['Javier López', 'Fontanero', 'Hidro Servicios'],
    ['Ana Torres', 'Arquitecta', 'Estudio Torres'],
  ];
  const members = [];
  for (const [i, [name, role, company]] of people.entries()) {
    const m = {
      id: uid(), projectId: pid, name, role, company,
      email: name.toLowerCase().split(' ')[0] + '@ejemplo.com', phone: '',
      color: MEMBER_COLORS[i % MEMBER_COLORS.length], createdAt: Date.now(),
    };
    await db.put('members', m);
    members.push(m);
  }

  const sheets = [];
  for (const [i, name] of ['A-101 Planta baja', 'A-102 Planta primera'].entries()) {
    const plan = await demoFloorPlan(i);
    const sheet = {
      id: uid(), projectId: pid, name, folder: 'Arquitectura', version: 1,
      fileId: await saveFile(pid, plan.blob, name), thumbId: await saveFile(pid, plan.thumb, name + ' (miniatura)'),
      width: plan.width, height: plan.height, createdAt: Date.now(),
    };
    await db.put('sheets', sheet);
    sheets.push(sheet);
  }

  const d = (offset) => {
    const x = new Date();
    x.setDate(x.getDate() + offset);
    return x.toISOString().slice(0, 10);
  };
  const demoTasks = [
    { title: 'Revisar fisura en muro de sala de reuniones', status: 'p1', category: 'Albañilería', a: 1, due: -2, s: 0, x: 0.18, y: 0.3, loc: 'Sala de reuniones' },
    { title: 'Instalar cuadro eléctrico secundario', status: 'p2', category: 'Electricidad', a: 2, due: 3, s: 0, x: 0.78, y: 0.6, loc: 'Cuarto técnico' },
    { title: 'Fuga en lavabo de aseos', status: 'p1', category: 'Fontanería', a: 3, due: 1, s: 0, x: 0.69, y: 0.47, loc: 'Aseos' },
    { title: 'Pintar recepción (2 manos)', status: 'p3', category: 'Pintura', a: 1, due: 10, s: 0, x: 0.44, y: 0.72, loc: 'Recepción' },
    { title: 'Colocar señalización de evacuación', status: 'done', category: 'Seguridad', a: 0, due: -5, s: 0, x: 0.5, y: 0.2, loc: 'Oficina abierta' },
    { title: 'Remates de carpintería en puerta de almacén', status: 'verified', category: 'Carpintería', a: 1, due: -8, s: 0, x: 0.15, y: 0.62, loc: 'Almacén' },
    { title: 'Replanteo de tabiquería de dormitorios', status: 'p2', category: 'Albañilería', a: 1, due: 5, s: 1, x: 0.5, y: 0.7, loc: 'Dormitorio 1' },
    { title: 'Prueba de estanqueidad en baño', status: 'p2', category: 'Fontanería', a: 3, due: -1, s: 1, x: 0.66, y: 0.66, loc: 'Baño' },
    { title: 'Validar acabados de cocina con cliente', status: 'p3', category: 'Acabados', a: 4, due: 14, s: 1, x: 0.8, y: 0.3, loc: 'Cocina' },
    { title: 'Solicitar certificado de instalación eléctrica', status: 'p2', category: 'Electricidad', a: 2, due: 7, s: -1, loc: '' },
  ];
  for (const t of demoTasks) {
    const task = await createTask(project, {
      title: t.title, status: t.status, category: t.category, assigneeId: members[t.a].id,
      dueDate: d(t.due), startDate: d(t.due - 7), location: t.loc,
      sheetId: t.s >= 0 ? sheets[t.s].id : '', x: t.s >= 0 ? t.x : null, y: t.s >= 0 ? t.y : null,
      checklist: t.status === 'p1'
        ? [{ id: uid(), text: 'Inspección visual', done: true }, { id: uid(), text: 'Fotografiar estado actual', done: false }, { id: uid(), text: 'Aprobar solución', done: false }]
        : [],
    }, 'Laura Gómez');
    if (!statusOf(t.status).open) {
      task.completedAt = Date.now() - 86400000 * 2;
      await db.put('tasks', task);
    }
    if (t.status === 'p1') {
      task.comments.push({ id: uid(), by: 'Laura Gómez', at: Date.now() - 3600000, text: 'Por favor, revisar antes del viernes.' });
      await db.put('tasks', task);
    }
  }
  return project;
}
