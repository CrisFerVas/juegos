// Arranque del servidor: `npm start`  (variables: PORT, HOST, DATA_DIR)
import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

const server = createApp({ dataDir, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
server.listen(port, host, () => {
  console.log(`ObraPlan escuchando en http://localhost:${port}  (datos en ${dataDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
