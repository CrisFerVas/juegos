// Carpetas y subcarpetas de planos (especialidades y subespecialidades).
// Un plano guarda su carpeta como ruta: "Instalaciones/Climatización/Ventilación" ('' = raíz de Planos).
// Las carpetas que existen aunque estén vacías se guardan en el almacén "folders": { id, projectId, path }.
// El resto se deduce de las rutas de los planos, así que los datos antiguos ("Arquitectura") siguen valiendo.

import { db, uid } from './db.js';
import { esc } from './ui.js';

export const SUGGESTED_FOLDERS = ['Arquitectura', 'Estructura', 'Instalaciones', 'Electricidad', 'Fontanería', 'Climatización', 'Urbanización', 'Otros'];

/** Normaliza una ruta: sin barras sobrantes ni espacios en los extremos de cada nivel. */
export const normPath = (p) => String(p || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
/** Un nombre de carpeta no puede contener "/" (separa niveles). */
export const cleanName = (n) => String(n || '').replace(/\//g, '-').trim();
export const baseName = (p) => p.split('/').at(-1) || '';
export const parentOf = (p) => p.split('/').slice(0, -1).join('/');
export const depthOf = (p) => (p ? p.split('/').length : 0);
/** ¿`p` es `folder` o está dentro de ella? */
export const isInside = (p, folder) => !folder || p === folder || p.startsWith(folder + '/');

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Todas las carpetas del proyecto (rutas), ordenadas como un árbol. */
export function allFolders(ctx) {
  const set = new Set();
  const add = (p) => {
    p = normPath(p);
    while (p) {
      set.add(p);
      p = parentOf(p);
    }
  };
  (ctx.folders || []).forEach((f) => add(f.path));
  ctx.sheets.forEach((s) => add(s.folder));
  // Orden de árbol: se compara nivel a nivel
  return [...set].sort((a, b) => {
    const A = a.split('/'), B = b.split('/');
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      const c = collator.compare(A[i], B[i]);
      if (c) return c;
    }
    return A.length - B.length;
  });
}

/** Subcarpetas directas de `path`. */
export const childFolders = (ctx, path) => allFolders(ctx).filter((p) => parentOf(p) === path);

/** Planos directamente en `path` o, con `deep`, también en sus subcarpetas. */
export const sheetsIn = (ctx, path, deep = false) =>
  ctx.sheets.filter((s) => (deep ? isInside(normPath(s.folder), path) : normPath(s.folder) === path));

/** Ruta legible: "Instalaciones › Climatización". */
export const prettyPath = (p) => (p ? p.split('/').join(' › ') : 'Planos (sin carpeta)');

/** Desplegable con todas las carpetas en forma de árbol. `exclude` oculta una carpeta y su contenido. */
export function folderOptions(ctx, selected = '', { exclude = null, rootLabel = 'Planos (sin carpeta)' } = {}) {
  const sel = normPath(selected);
  const list = allFolders(ctx).filter((p) => !(exclude != null && isInside(p, exclude)));
  return [`<option value="" ${sel === '' ? 'selected' : ''}>${esc(rootLabel)}</option>`, ...list.map((p) => {
    const pad = '   '.repeat(depthOf(p) - 1);
    return `<option value="${esc(p)}" ${p === sel ? 'selected' : ''}>${pad}${depthOf(p) > 1 ? '└ ' : ''}${esc(baseName(p))}</option>`;
  })].join('');
}

/**
 * Campos para elegir carpeta y, opcionalmente, crear una subcarpeta nueva dentro de ella.
 * Lee el resultado con `folderFromForm(values)`.
 */
export function folderPickerHTML(ctx, selected = '') {
  return `
    <label class="field"><span>Carpeta</span><select name="folder">${folderOptions(ctx, selected)}</select></label>
    <label class="field"><span>Nueva subcarpeta dentro de la elegida (opcional)</span>
      <input name="newFolder" list="folder-suggest" placeholder="Ej. Climatización" autocomplete="off" />
      <datalist id="folder-suggest">${SUGGESTED_FOLDERS.map((f) => `<option value="${esc(f)}"></option>`).join('')}</datalist>
    </label>`;
}
export const folderFromForm = (v) => normPath([v.folder, cleanName(v.newFolder)].filter(Boolean).join('/'));

/** Crea una carpeta (aunque esté vacía). Devuelve su ruta. */
export async function createFolder(ctx, path) {
  path = normPath(path);
  if (!path) return '';
  if (!(ctx.folders || []).some((f) => f.path === path)) {
    await db.put('folders', { id: uid(), projectId: ctx.project.id, path, createdAt: Date.now() });
  }
  return path;
}

/** Cambia la ruta de una carpeta (renombrar o mover): actualiza sus planos y subcarpetas. */
export async function moveFolder(ctx, from, to) {
  from = normPath(from);
  to = normPath(to);
  if (!from || !to || from === to) return;
  if (isInside(to, from)) throw new Error('No se puede mover una carpeta dentro de sí misma');
  const swap = (p) => to + normPath(p).slice(from.length);
  for (const s of ctx.sheets) {
    if (!isInside(normPath(s.folder), from)) continue;
    s.folder = swap(s.folder);
    await db.put('sheets', s);
  }
  const existing = new Set((ctx.folders || []).filter((f) => !isInside(normPath(f.path), from)).map((f) => f.path));
  for (const f of ctx.folders || []) {
    if (!isInside(normPath(f.path), from)) continue;
    const next = swap(f.path);
    if (existing.has(next)) {
      await db.del('folders', f.id); // ya existía una carpeta con ese nombre: se fusionan
    } else {
      f.path = next;
      existing.add(next);
      await db.put('folders', f);
    }
  }
  await createFolder({ ...ctx, folders: [...existing].map((path) => ({ path })) }, to);
}

/** Elimina una carpeta: sus planos y subcarpetas pasan a la carpeta superior. */
export async function deleteFolder(ctx, path) {
  path = normPath(path);
  const parent = parentOf(path);
  const swap = (p) => normPath(parent + '/' + normPath(p).slice(path.length + 1));
  for (const s of ctx.sheets) {
    const p = normPath(s.folder);
    if (!isInside(p, path)) continue;
    s.folder = p === path ? parent : swap(p);
    await db.put('sheets', s);
  }
  for (const f of ctx.folders || []) {
    const p = normPath(f.path);
    if (p === path) await db.del('folders', f.id);
    else if (isInside(p, path)) {
      f.path = swap(p);
      await db.put('folders', f);
    }
  }
}
