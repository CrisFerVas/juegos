// Avisos de tareas pendientes: lógica común a la app y al service worker.
// Es un script clásico (sin import/export): la app lo importa como módulo por su efecto
// (define self.ObraReminders) y el service worker lo carga con importScripts.
//
// Reglas:
// - Prioridad alta = urgente: 4 avisos al día, repartidos en el horario (por defecto 8:00-15:00).
// - Prioridad media: 2 avisos al día (1 h después del inicio y hacia el 70 % del horario).
// - Prioridad baja: sin avisos.
// - Cualquier tarea pendiente con fecha límite pasa a urgente cuando falta 1 día o menos (o está vencida).
// - Solo en días laborables (lunes a viernes; sábado y domingo opcionales).

(function (g) {
  const DEFAULTS = { enabled: false, start: 8, end: 15, saturday: false, sunday: false, onlyMine: true };
  const CACHE = 'obraplan-reminders';
  const CONFIG_URL = './__reminders/config';
  const STATE_URL = './__reminders/state';
  const OPEN = { p1: 'high', p2: 'medium', p3: 'low' };

  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtMin = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  /** Días enteros de `fromISO` a `toISO` (negativo si `toISO` ya pasó). */
  const daysBetween = (fromISO, toISO) => Math.round((Date.parse(toISO + 'T12:00:00') - Date.parse(fromISO + 'T12:00:00')) / 86400000);

  /** Minutos del día en que suena cada nivel. */
  function slotsFor(level, s) {
    const a = Math.round(s.start * 60), b = Math.max(a + 60, Math.round(s.end * 60));
    if (level === 'urgent') return [0, 1, 2, 3].map((i) => Math.round((a + ((b - a) * i) / 3) / 5) * 5);
    if (level === 'medium') return [Math.min(b, a + 60), Math.min(b, Math.round((a + (b - a) * 0.7) / 30) * 30)];
    return [];
  }

  /** Nivel de aviso de una tarea hoy: { level: 'urgent' | 'medium' | null, reason }. */
  function levelOf(task, today) {
    const pr = OPEN[task.status];
    if (!pr) return { level: null }; // completada o verificada
    if (task.dueDate) {
      const left = daysBetween(today, task.dueDate);
      if (left <= 1) {
        const reason = left < 0 ? `vencida hace ${-left} día${left < -1 ? 's' : ''}` : left === 0 ? 'vence hoy' : 'vence mañana';
        return { level: 'urgent', reason, escalated: pr !== 'high' };
      }
    }
    if (pr === 'high') return { level: 'urgent', reason: 'prioridad alta' };
    if (pr === 'medium') return { level: 'medium', reason: 'prioridad media' };
    return { level: null };
  }

  function isWorkday(d, s) {
    const wd = d.getDay();
    return (wd >= 1 && wd <= 5) || (wd === 6 && s.saturday) || (wd === 0 && s.sunday);
  }

  /** Programa del día: [{ level, minutes: [...] }] y tareas con su nivel. */
  function plan(tasks, now, s) {
    const today = isoDay(now);
    const list = tasks.map((t) => ({ task: t, ...levelOf(t, today) })).filter((x) => x.level);
    return {
      workday: isWorkday(now, s),
      urgent: list.filter((x) => x.level === 'urgent'),
      medium: list.filter((x) => x.level === 'medium'),
      slots: { urgent: slotsFor('urgent', s), medium: slotsFor('medium', s) },
    };
  }

  /** Avisos que tocan entre `last` (excluido) y `now` (incluido), solo del día de hoy. */
  function dueNow(tasks, now, last, s) {
    if (!isWorkday(now, s)) return [];
    const p = plan(tasks, now, s);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const from = Math.max(last, startOfDay - 1);
    const hit = (mins) => mins.some((m) => {
      const t = startOfDay + m * 60000;
      return t > from && t <= now.getTime();
    });
    return [...(hit(p.slots.urgent) ? p.urgent : []), ...(hit(p.slots.medium) ? p.medium : [])];
  }

  // ---------- Datos (IndexedDB sin dependencias: sirve en la app y en el service worker) ----------
  function readAll(dbName) {
    return new Promise((resolve) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        const stores = ['tasks', 'projects', 'members'];
        if (!stores.every((n) => db.objectStoreNames.contains(n))) {
          db.close();
          return resolve(null);
        }
        const tx = db.transaction(stores, 'readonly');
        const out = {};
        stores.forEach((n) => {
          const r = tx.objectStore(n).getAll();
          r.onsuccess = () => (out[n] = r.result);
        });
        tx.oncomplete = () => {
          db.close();
          resolve(out);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    });
  }

  async function getJSON(url, fallback) {
    try {
      const r = await (await caches.open(CACHE)).match(url);
      return r ? await r.json() : fallback;
    } catch {
      return fallback;
    }
  }
  async function putJSON(url, value) {
    try {
      await (await caches.open(CACHE)).put(url, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
    } catch {
      /* sin Cache API */
    }
  }

  const getConfig = async () => ({ ...DEFAULTS, dbName: 'obraplan', myEmail: '', ...(await getJSON(CONFIG_URL, {})) });
  const setConfig = (c) => putJSON(CONFIG_URL, c);

  /** Tareas pendientes que me afectan (en modo equipo: asignadas a mí o sin asignar, si así se eligió). */
  function relevantTasks(data, cfg) {
    const projects = new Map((data.projects || []).map((p) => [p.id, p]));
    const members = new Map((data.members || []).map((m) => [m.id, m]));
    const me = (cfg.myEmail || '').toLowerCase();
    return (data.tasks || []).filter((t) => {
      if (!projects.has(t.projectId) || !OPEN[t.status]) return false;
      if (!me || !cfg.onlyMine || !t.assigneeId) return true;
      return (members.get(t.assigneeId)?.email || '').toLowerCase() === me;
    }).map((t) => ({ ...t, projectName: projects.get(t.projectId)?.name || '' }));
  }

  const LABEL = { urgent: 'Urgente', medium: 'Prioridad media' };

  /** Muestra los avisos (uno por tarea, o un resumen si son muchas). */
  async function notify(reg, items, base) {
    const show = (title, opts) => (reg?.showNotification ? reg.showNotification(title, opts) : new Notification(title, opts));
    const icon = base + 'icons/icon.svg';
    for (const level of ['urgent', 'medium']) {
      const list = items.filter((x) => x.level === level);
      if (!list.length) continue;
      if (list.length <= 3) {
        for (const x of list) {
          const t = x.task;
          await show(`${level === 'urgent' ? '🔴' : '🟠'} ${LABEL[level]} · Tarea #${t.number}`, {
            body: `${t.title}\n${x.reason}${t.projectName ? ` · ${t.projectName}` : ''}`,
            tag: `task-${t.id}`,
            renotify: true,
            icon,
            badge: icon,
            requireInteraction: level === 'urgent',
            data: { url: `${base}#/p/${t.projectId}/tasks?task=${t.id}` },
          });
        }
      } else {
        const projects = [...new Set(list.map((x) => x.task.projectId))];
        await show(`${level === 'urgent' ? '🔴' : '🟠'} ${list.length} tareas ${level === 'urgent' ? 'urgentes' : 'de prioridad media'}`, {
          body: list.slice(0, 5).map((x) => `#${x.task.number} ${x.task.title} (${x.reason})`).join('\n') + (list.length > 5 ? `\n+${list.length - 5} más` : ''),
          tag: `summary-${level}`,
          renotify: true,
          icon,
          badge: icon,
          requireInteraction: level === 'urgent',
          data: { url: projects.length === 1 ? `${base}#/p/${projects[0]}/tasks` : `${base}#/` },
        });
      }
    }
  }

  /**
   * Comprueba si toca avisar y, si es así, muestra las notificaciones.
   * `reg`: ServiceWorkerRegistration (o null para usar `new Notification`). `base`: URL de la app.
   */
  async function check(reg, base, now = new Date()) {
    const cfg = await getConfig();
    if (!cfg.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0;
    const state = await getJSON(STATE_URL, {});
    const last = state.last || now.getTime() - 60000; // primera vez: sin avisos atrasados
    await putJSON(STATE_URL, { last: now.getTime() });
    const data = await readAll(cfg.dbName);
    if (!data) return 0;
    const items = dueNow(relevantTasks(data, cfg), now, last, cfg);
    if (items.length) await notify(reg, items, base);
    return items.length;
  }

  g.ObraReminders = { DEFAULTS, slotsFor, levelOf, plan, dueNow, readAll, relevantTasks, getConfig, setConfig, notify, check, fmtMin, isoDay };
})(typeof self !== 'undefined' ? self : globalThis);
