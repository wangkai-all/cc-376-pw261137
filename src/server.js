// HTTP layer. The web UI is served from public/; JSON under /api.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { createRouter, sendJson } from './lib/http.js';
import { openDb, ROOT } from './lib/db.js';
import { ApiError } from './lib/util.js';
import * as q from './services/quality.js';

const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createApp({ dbFile, version = '1.0.0' } = {}) {
  const db = openDb(dbFile);
  q.recordSchemaVersion(db, version);
  const router = buildRoutes(db);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await router.handle(req, res);
      return;
    }
    serveStatic(req, res, url);
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return { server, db, close: () => { server.close(); db.close(); } };
}

function buildRoutes(db) {
  const r = createRouter();

  r.get('/api/health', () => ({ ok: true, now: new Date().toISOString(), version: q.schemaVersion(db) }));
  r.get('/api/overview', () => q.overview(db));
  r.get('/api/summaries', () => ({ summaries: q.listSummaries(db) }));

  r.get('/api/batches', () => ({ batches: q.listBatches(db) }));
  r.get('/api/batches/:id', ({ params }) => q.getBatch(db, params.id));
  r.post('/api/ingest', ({ body }) => q.ingestBatch(db, body));

  r.get('/api/artifacts', () => ({ artifacts: q.listArtifacts(db) }));
  r.get('/api/artifacts/:id/download', ({ params, res }) => {
    const art = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(params.id);
    if (!art) throw new ApiError(404, '导出文件不存在');
    const full = join(ROOT, normalize(art.path));
    if (!full.startsWith(join(ROOT, 'data', 'exports') + sep) || !existsSync(full)) {
      throw new ApiError(404, '导出文件缺失');
    }
    if (!q.artifactHashMatches(art)) throw new ApiError(409, '导出文件哈希与记录不一致，拒绝下发');
    const content = readFileSync(full, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${art.path.split('/').pop()}"`,
      'content-length': Buffer.byteLength(content),
      'cache-control': 'no-store',
    });
    res.end(content);
    return undefined;
  });

  r.get('/api/cases', () => ({ cases: q.listCases(db) }));
  r.get('/api/cases/:id', ({ params }) => q.getCase(db, params.id));
  r.post('/api/cases', ({ body }) => q.openCase(db, body));
  r.post('/api/work/:id/execute', ({ params }) => q.executeReversibleWork(db, params.id));
  r.post('/api/work/:id/replay', ({ params }) => q.executeReplay(db, params.id));
  r.post('/api/work/:id/ack-loss', ({ params, body }) => q.acknowledgeLoss(db, params.id, body));
  r.post('/api/work/:id/fail', ({ params, body }) => q.failWork(db, params.id, body?.reason));

  r.post('/api/corrections', ({ body }) => q.publishCorrection(db, body));
  r.post('/api/corrections/:id/verify', ({ params }) => q.verifyCorrection(db, params.id));

  // Consumer endpoints: only these two consumers may write consumptions.
  r.post('/api/consumers/:name/consume', ({ params, body }) => {
    const batchId = String(body?.batch_id ?? '');
    if (!batchId) throw new ApiError(400, 'batch_id 不能为空');
    return q.consumeBatch(db, { consumer: params.name, batchId });
  });

  // Read-only projections used by the simulator panel.
  r.get('/api/catalog', ({ query }) => {
    const batch = query.get('batch');
    const rows = batch
      ? db.prepare('SELECT * FROM catalog_assets WHERE batch_id = ? ORDER BY row_id').all(batch)
      : db.prepare('SELECT * FROM catalog_assets ORDER BY batch_id, row_id').all();
    return { assets: rows };
  });
  r.get('/api/consumptions', ({ query }) => {
    const batch = query.get('batch');
    const rows = batch
      ? db.prepare('SELECT * FROM consumptions WHERE batch_id = ? ORDER BY consumer, region, row_id').all(batch)
      : db.prepare('SELECT * FROM consumptions ORDER BY batch_id, consumer, region, row_id').all();
    const counts = db.prepare('SELECT consumer, state, reversible, COUNT(*) n, COALESCE(SUM(amount),0) amount FROM consumptions GROUP BY consumer, state, reversible').all();
    return { consumptions: rows, counts };
  });
  r.get('/api/ledger', () => ({
    ledger: db.prepare('SELECT * FROM summary_ledger ORDER BY seq').all(),
  }));

  return r;
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC + sep) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const body = readFileSync(full);
  res.writeHead(200, {
    'content-type': MIME[extname(full)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
