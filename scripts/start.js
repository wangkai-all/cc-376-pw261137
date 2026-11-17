import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/lib/db.js';
import { seed } from './seed.js';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const dbFile = process.env.DB_FILE || join(ROOT, 'data', 'revocation.db');
if (process.env.SEED !== '0') {
  const out = seed();
  if (out.seeded) console.log(`[seed] 已注入演示场景，处置单 ${out.case_id}`);
}
const app = createApp({ dbFile });
app.server.listen(port, host, () => {
  console.log(`撤销传播处置台: http://${host}:${port}`);
  console.log(`数据库: ${dbFile}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.server.close(() => { app.db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
