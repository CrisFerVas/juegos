// Avisos de tareas en la app: ajustes, permiso de notificaciones y comprobación periódica.
// Sin servidor de notificaciones push, los avisos salen del propio dispositivo:
// - con la app abierta (aunque esté en segundo plano), se comprueba cada minuto;
// - al volver a abrirla, se avisa de lo que tocó hoy y no se avisó;
// - con la app instalada (Chrome en Android), la sincronización periódica en segundo plano
//   despierta al service worker de vez en cuando (la frecuencia la decide el navegador).

import './reminders-core.js';
import { currentDBName } from './db.js';
import { session } from './sync.js';

const R = self.ObraReminders;
const BASE = new URL('./', location.href).href;
let timer = null;

export const remindersSupported = () => typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
export const permission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
export const getReminderSettings = () => R.getConfig();
export const reminderPlan = (tasks, s) => R.plan(tasks, new Date(), s);
export const { slotsFor, fmtMin, levelOf, isoDay } = R;

/** Guarda los ajustes (y los datos que necesita el service worker: base de datos y usuario). */
export async function saveReminderSettings(patch = {}) {
  const cfg = { ...(await R.getConfig()), ...patch, dbName: currentDBName(), myEmail: session.mode === 'server' ? session.user?.email || '' : '' };
  await R.setConfig(cfg);
  start();
  return cfg;
}

/** Pide permiso y activa los avisos. Devuelve el permiso resultante. */
export async function enableReminders() {
  if (!remindersSupported()) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p === 'granted') {
    await saveReminderSettings({ enabled: true });
    await registerPeriodicSync();
  }
  return p;
}

async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return false;
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state !== 'granted') return false;
    await reg.periodicSync.register('obraplan-reminders', { minInterval: 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

async function registration() {
  try {
    return navigator.serviceWorker?.controller ? await navigator.serviceWorker.ready : null;
  } catch {
    return null;
  }
}

/** Comprueba ahora si toca avisar. */
export async function checkReminders() {
  try {
    return await R.check(await registration(), BASE);
  } catch {
    return 0;
  }
}

/** Muestra un aviso de prueba. */
export async function testReminder() {
  const reg = await registration();
  const opts = { body: 'Así te llegarán los avisos de tareas pendientes.', tag: 'obraplan-test', icon: BASE + 'icons/icon.svg', data: { url: BASE } };
  if (reg) await reg.showNotification('🔔 ObraPlan · aviso de prueba', opts);
  else new Notification('🔔 ObraPlan · aviso de prueba', opts);
}

/** Arranca las comprobaciones (al iniciar la app y al cambiar los ajustes). */
export async function start() {
  clearInterval(timer);
  const cfg = await R.getConfig();
  if (!cfg.enabled) return;
  // Los datos del usuario actual (en modo equipo cambia la base de datos)
  if (cfg.dbName !== currentDBName() || (session.mode === 'server' && cfg.myEmail !== (session.user?.email || ''))) {
    await R.setConfig({ ...cfg, dbName: currentDBName(), myEmail: session.mode === 'server' ? session.user?.email || '' : '' });
  }
  registerPeriodicSync();
  checkReminders();
  timer = setInterval(checkReminders, 60 * 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkReminders();
});
