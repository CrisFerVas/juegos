// Tareas de administración del servidor desde la línea de comandos.
//   npm run admin -- reset-password <email> [horas]   Código de un solo uso para restablecer la contraseña
//   npm run admin -- users                            Lista de cuentas
// Usa la misma carpeta de datos que el servidor (DATA_DIR, por defecto ./data). Puede ejecutarse con el servidor en marcha.
import path from 'node:path';
import fs from 'node:fs';
import { openStore } from './store.js';
import { makeCode, hashCode } from './app.js';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const file = path.join(dataDir, 'obraplan.db');
const [cmd, ...args] = process.argv.slice(2);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
if (!fs.existsSync(file)) fail(`No hay datos en ${dataDir} (variable DATA_DIR).`);
const store = openStore(file);
const { q, db } = store;

if (cmd === 'reset-password') {
  const email = String(args[0] || '').trim().toLowerCase();
  const hours = Math.min(168, Math.max(1, Number(args[1]) || 24));
  const user = email && q.userByEmail.get(email);
  if (!user) fail(`No existe ninguna cuenta con el email «${email}».`);
  const code = makeCode(3);
  q.insertResetCode.run(hashCode(code), user.id, Date.now() + hours * 3600000);
  console.log(`Código para ${user.name} <${user.email}> (válido ${hours} h, un solo uso):\n\n    ${code}\n`);
  console.log('En la app: Iniciar sesión › ¿Olvidaste tu contraseña? › introduce el email, este código y la contraseña nueva.');
} else if (cmd === 'users') {
  const rows = db.prepare(`SELECT u.email, u.name, u.created_at, COUNT(m.project_id) AS projects
    FROM users u LEFT JOIN memberships m ON m.user_id = u.id GROUP BY u.id ORDER BY u.created_at`).all();
  for (const r of rows) console.log(`${r.email}\t${r.name}\t${r.projects} proyecto(s)\t${new Date(r.created_at).toISOString().slice(0, 10)}`);
  if (!rows.length) console.log('No hay cuentas.');
} else {
  console.log('Uso:\n  npm run admin -- reset-password <email> [horas]\n  npm run admin -- users');
}
store.close();
