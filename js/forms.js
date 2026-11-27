// Partes e inspecciones: plantillas incluidas, creación de partes, resumen e impresión.

import { db, uid, fileUrl, todayISO } from './db.js';
import { esc, fmtDate, fmtDateTime, userName } from './ui.js';

export const FIELD_TYPES = [
  { id: 'text', n: 'Texto corto' },
  { id: 'textarea', n: 'Texto largo' },
  { id: 'number', n: 'Número' },
  { id: 'date', n: 'Fecha' },
  { id: 'select', n: 'Lista de opciones' },
  { id: 'yesno', n: 'Sí / No' },
  { id: 'check', n: 'Punto de inspección (Conforme / No conforme / N/A)' },
  { id: 'crew', n: 'Personal en obra (tabla)' },
];

export const CHECK_RESULTS = [
  { id: 'ok', n: 'Conforme', short: '✓', color: '#16a34a' },
  { id: 'nc', n: 'No conforme', short: '✗', color: '#dc2626' },
  { id: 'na', n: 'No aplica', short: 'N/A', color: '#64748b' },
];

const f = (label, type = 'text', extra = {}) => ({ id: label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40), label, type, ...extra });
const checks = (labels) => labels.map((l) => f(l, 'check'));

/** Plantillas incluidas (no se guardan; los partes guardan una copia de la plantilla usada). */
export const BUILTIN_TEMPLATES = [
  {
    id: 'tpl-parte-diario',
    builtin: true,
    kind: 'daily',
    name: 'Parte diario de obra',
    description: 'Clima, personal, trabajos realizados, materiales e incidencias del día.',
    sections: [
      { title: 'Condiciones', fields: [f('Clima', 'select', { options: ['Soleado', 'Nublado', 'Lluvia', 'Viento', 'Helada', 'Nieve'] }), f('Temperatura (°C)', 'number'), f('Horario de trabajo')] },
      { title: 'Personal en obra', fields: [f('Personal', 'crew')] },
      { title: 'Trabajos', fields: [f('Trabajos realizados', 'textarea', { required: true }), f('Trabajos previstos para mañana', 'textarea')] },
      { title: 'Recursos', fields: [f('Materiales recibidos', 'textarea'), f('Maquinaria en obra', 'textarea')] },
      { title: 'Incidencias y visitas', fields: [f('Incidencias', 'textarea'), f('Visitas a obra', 'textarea'), f('Accidentes o incidentes de seguridad', 'yesno')] },
    ],
  },
  {
    id: 'tpl-inspeccion-calidad',
    builtin: true,
    kind: 'quality',
    name: 'Inspección de calidad',
    description: 'Comprobación de la ejecución por puntos: conforme, no conforme o no aplica.',
    sections: [
      { title: 'Datos de la inspección', fields: [f('Zona / unidad inspeccionada', 'text', { required: true }), f('Partida', 'select', { options: ['Albañilería', 'Estructura', 'Instalaciones', 'Climatización', 'Electricidad', 'Fontanería', 'Acabados', 'Carpintería', 'Otra'] }), f('Empresa ejecutora')] },
      {
        title: 'Puntos de inspección',
        fields: checks([
          'Ejecución conforme a planos y especificaciones',
          'Materiales conformes a lo aprobado',
          'Replanteo, cotas y niveles correctos',
          'Uniones, fijaciones y soportes correctos',
          'Estanqueidad / pruebas realizadas',
          'Acabado superficial y limpieza',
          'Protección de elementos terminados',
        ]),
      },
      { title: 'Conclusión', fields: [f('Resultado', 'select', { options: ['Aceptado', 'Aceptado con observaciones', 'Rechazado'] }), f('Observaciones', 'textarea')] },
    ],
  },
  {
    id: 'tpl-checklist-seguridad',
    builtin: true,
    kind: 'safety',
    name: 'Checklist de seguridad (PRL)',
    description: 'Revisión de prevención de riesgos: EPIs, señalización, medios auxiliares y orden.',
    sections: [
      { title: 'Datos', fields: [f('Zona revisada', 'text', { required: true }), f('Nº de trabajadores presentes', 'number')] },
      {
        title: 'Equipos de protección y señalización',
        fields: checks(['Uso de casco', 'Uso de calzado de seguridad', 'Uso de chaleco reflectante', 'Protección auditiva / ocular donde se requiere', 'Señalización de riesgos visible', 'Accesos y vías de evacuación libres']),
      },
      {
        title: 'Medios auxiliares e instalaciones',
        fields: checks(['Andamios montados, revisados y señalizados', 'Escaleras de mano en buen estado', 'Protecciones colectivas (barandillas, redes) en huecos y bordes', 'Cuadros eléctricos cerrados y protegidos', 'Extintores accesibles y revisados']),
      },
      { title: 'Orden y limpieza', fields: checks(['Zonas de paso limpias y ordenadas', 'Acopios estables y señalizados', 'Residuos segregados en contenedores']) },
      { title: 'Medidas correctoras', fields: [f('Medidas correctoras adoptadas', 'textarea'), f('Paralización de trabajos', 'yesno')] },
    ],
  },
];

export async function listTemplates(projectId) {
  const custom = (await db.byProject('templates', projectId)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return [...BUILTIN_TEMPLATES, ...custom];
}

export async function getTemplate(projectId, id) {
  return BUILTIN_TEMPLATES.find((t) => t.id === id) || (await db.get('templates', id));
}

/** Crea un parte a partir de una plantilla (guarda una copia de la plantilla). */
export async function createForm(project, template) {
  const existing = await db.byProject('forms', project.id);
  const number = existing.reduce((m, x) => Math.max(m, x.number || 0), 0) + 1;
  const now = Date.now();
  const { id: templateId, name, kind, sections } = template;
  const form = {
    id: uid(),
    projectId: project.id,
    number,
    templateId,
    template: structuredClone({ name, kind, sections }),
    title: name,
    date: todayISO(),
    values: {},
    photoIds: [],
    signature: null,
    status: 'draft',
    author: userName(),
    linkedTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.put('forms', form);
  return form;
}

/** Resumen de puntos de inspección: { ok, nc, na, pending, total }. */
export function checkSummary(form) {
  const out = { ok: 0, nc: 0, na: 0, pending: 0, total: 0 };
  for (const s of form.template.sections) {
    for (const fd of s.fields) {
      if (fd.type !== 'check') continue;
      out.total++;
      const r = form.values[fd.id]?.result;
      if (r) out[r]++;
      else out.pending++;
    }
  }
  return out;
}

/** Campos obligatorios sin rellenar. */
export function missingRequired(form) {
  const missing = [];
  for (const s of form.template.sections) {
    for (const fd of s.fields) {
      if (!fd.required) continue;
      const v = form.values[fd.id];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) missing.push(fd.label);
    }
  }
  return missing;
}

export const KIND_LABEL = { daily: 'Parte diario', quality: 'Calidad', safety: 'Seguridad', custom: 'Personalizado' };

/** Informe imprimible (o para guardar como PDF) de un parte. */
export async function printForm(form, project, members = []) {
  const w = window.open('', '_blank');
  if (!w) return false;
  const photos = await Promise.all(form.photoIds.map(fileUrl));
  const signature = form.signature?.fileId ? await fileUrl(form.signature.fileId) : '';
  const valueHTML = (fd) => {
    const v = form.values[fd.id];
    if (fd.type === 'check') {
      const r = CHECK_RESULTS.find((x) => x.id === v?.result);
      return `<span class="res" style="--c:${r ? r.color : '#94a3b8'}">${r ? r.n : 'Sin revisar'}</span>${v?.note ? `<div class="note">${esc(v.note)}</div>` : ''}`;
    }
    if (fd.type === 'crew') {
      const rows = Array.isArray(v) ? v.filter((r) => r.company || r.trade || r.workers) : [];
      if (!rows.length) return '<span class="muted">—</span>';
      const total = rows.reduce((s, r) => s + (Number(r.workers) || 0), 0);
      return `<table class="crew"><tr><th>Empresa</th><th>Oficio</th><th>Nº</th><th>Horas</th></tr>${rows
        .map((r) => `<tr><td>${esc(r.company)}</td><td>${esc(r.trade)}</td><td>${esc(r.workers)}</td><td>${esc(r.hours)}</td></tr>`)
        .join('')}<tr><td colspan="2"><b>Total</b></td><td><b>${total}</b></td><td></td></tr></table>`;
    }
    if (fd.type === 'yesno') return v === true ? 'Sí' : v === false ? 'No' : '<span class="muted">—</span>';
    if (fd.type === 'date') return v ? esc(fmtDate(v)) : '<span class="muted">—</span>';
    return v ? esc(v).replace(/\n/g, '<br>') : '<span class="muted">—</span>';
  };
  const sum = checkSummary(form);
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(form.title)} #${form.number}</title>
  <style>
    body{font:13px/1.45 system-ui,sans-serif;color:#0f172a;margin:28px}
    h1{font-size:20px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px;padding-bottom:4px;border-bottom:2px solid #0f766e;color:#0f766e;text-transform:uppercase;letter-spacing:.04em}
    .muted{color:#64748b} .meta{display:flex;flex-wrap:wrap;gap:4px 18px;color:#475569}
    .row{display:grid;grid-template-columns:38% 1fr;gap:10px;padding:5px 0;border-bottom:1px solid #e2e8f0;break-inside:avoid}
    .label{font-weight:600} .res{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--c);color:var(--c);font-weight:600;font-size:12px}
    .note{margin-top:3px;color:#334155} .crew{border-collapse:collapse;width:100%} .crew td,.crew th{border:1px solid #cbd5e1;padding:3px 6px;text-align:left}
    .sum{display:flex;gap:14px;margin-top:6px} .photos{display:flex;flex-wrap:wrap;gap:6px} .photos img{width:160px;height:120px;object-fit:cover;border-radius:4px}
    .sign img{max-width:260px;max-height:110px;border-bottom:1px solid #0f172a} @media print{body{margin:12mm}}
  </style></head><body>
  <h1>${esc(form.title)} · nº ${form.number}</h1>
  <div class="meta"><span><b>Proyecto:</b> ${esc(project.name)}</span><span><b>Fecha:</b> ${esc(fmtDate(form.date))}</span>
    <span><b>Redactado por:</b> ${esc(form.author || '')}</span><span><b>Estado:</b> ${form.status === 'closed' ? 'Cerrado' : 'Borrador'}</span></div>
  ${sum.total ? `<div class="sum"><span style="color:#16a34a"><b>${sum.ok}</b> conformes</span><span style="color:#dc2626"><b>${sum.nc}</b> no conformes</span><span><b>${sum.na}</b> no aplica</span>${sum.pending ? `<span class="muted"><b>${sum.pending}</b> sin revisar</span>` : ''}</div>` : ''}
  ${form.template.sections.map((s) => `<h2>${esc(s.title)}</h2>${s.fields.map((fd) => `<div class="row"><div class="label">${esc(fd.label)}</div><div>${valueHTML(fd)}</div></div>`).join('')}`).join('')}
  ${photos.filter(Boolean).length ? `<h2>Fotos</h2><div class="photos">${photos.filter(Boolean).map((u) => `<img src="${u}">`).join('')}</div>` : ''}
  ${signature ? `<h2>Firma</h2><div class="sign"><img src="${signature}"><div>${esc(form.signature.name || '')} · ${esc(fmtDateTime(form.signature.at))}</div></div>` : ''}
  <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
  return true;
}
