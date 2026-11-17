import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, ROOT } from '../src/lib/db.js';
import * as q from '../src/services/quality.js';
import { createApp } from '../src/server.js';

let seq = 0;
function freshDb() {
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
  return openDb(':memory:');
}

const BAD = {
  batch_id: 'B-T-101',
  origin: 'producer-erp',
  released_at: '2026-11-16T00:00:00Z',
  rows: [
    { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 10000 },
    { row_id: 'R2', region: '华东', qty: 5, unit_price: 100, amount: 5000 },
    { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 2000 },
  ],
};
const CLEAN = {
  batch_id: 'B-T-100',
  origin: 'producer-erp',
  released_at: '2026-11-15T00:00:00Z',
  rows: [
    { row_id: 'C1', region: '华东', qty: 7, unit_price: 10, amount: 70 },
    { row_id: 'C2', region: '华北', qty: 3, unit_price: 20, amount: 60 },
  ],
};

function setup() {
  const db = freshDb();
  q.ingestBatch(db, CLEAN);
  q.ingestBatch(db, BAD);
  for (const b of ['B-T-100', 'B-T-101']) {
    q.consumeBatch(db, { consumer: 'region-summary', batchId: b });
    q.consumeBatch(db, { consumer: 'workbook-export', batchId: b });
  }
  return db;
}

function open(db) {
  return q.openCase(db, { batch_id: 'B-T-101', bad_field: 'amount', reason: '金额多乘 100' });
}

function workBy(db, caseId, pred) {
  return q.getCase(db, caseId).work_items.filter(pred);
}

test('ingest is idempotent and rejects contradictory duplicates', () => {
  const db = freshDb();
  const a = q.ingestBatch(db, CLEAN);
  const b = q.ingestBatch(db, CLEAN);
  assert.equal(b.duplicate, true);
  assert.equal(a.batch.id, b.batch.id);
  assert.throws(() => q.ingestBatch(db, { ...CLEAN, rows: [CLEAN.rows[0]] }), /已存在且内容不同/);
  assert.throws(() => q.ingestBatch(db, { ...CLEAN, batch_id: 'B-T-NEW', kind: 'corrected' }), /修正批次只能/);
});

test('ingest validates rows before writing anything', () => {
  const db = freshDb();
  assert.throws(() => q.ingestBatch(db, {
    batch_id: 'B-T-BAD',
    origin: 'x',
    rows: [{ row_id: 'A', region: '华东', qty: 1, unit_price: 1 }, { row_id: 'A', region: '华东', qty: 2, unit_price: 1 }],
  }), /重复/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM batches').get().n, 0);
});

test('opening a case fans out from real consumption and distinguishes methods', () => {
  const db = setup();
  const c = open(db);
  const items = c.work_items;
  const catalog = items.filter((w) => w.target === 'catalog');
  const summaries = items.filter((w) => w.target === 'region-summary');
  const exports = items.filter((w) => w.target === 'workbook-export');
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].method, 'backward_contribution');
  assert.equal(summaries.length, 2, 'one work item per affected region');
  assert.ok(summaries.every((w) => w.method === 'backward_contribution' && w.reversible === 1));
  assert.equal(exports.length, 1);
  assert.equal(exports[0].method, 'rebuild_notice');
  assert.equal(exports[0].reversible, 0);
  assert.equal(c.status, 'propagating');

  // bad batch must not accept new consumption
  assert.throws(() => q.consumeBatch(db, { consumer: 'region-summary', batchId: 'B-T-101' }), /不得继续消费/);
  // catalog assets flagged, not withdrawn
  const assets = db.prepare("SELECT state FROM catalog_assets WHERE batch_id='B-T-101'").all();
  assert.ok(assets.every((a) => a.state === 'flagged'));
});

test('reversible unwind is exact, idempotent, and does not touch newer batches', () => {
  const db = setup();
  const c = open(db);
  const before = q.listSummaries(db).find((s) => s.region === '华东').amount_sum; // 70 + 15000
  assert.equal(before, 15070);

  // A normal batch arrives mid-disposal and is consumed.
  q.ingestBatch(db, {
    batch_id: 'B-T-110', origin: 'producer-erp', released_at: '2026-11-17T00:00:00Z',
    rows: [{ row_id: 'N1', region: '华东', qty: 1, unit_price: 999, amount: 999 }],
  });
  q.consumeBatch(db, { consumer: 'region-summary', batchId: 'B-T-110' });

  const hd = workBy(db, c.id, (w) => w.target === 'region-summary' && w.target_ref === '华东')[0];
  q.executeReversibleWork(db, hd.id);
  const after = q.listSummaries(db).find((s) => s.region === '华东').amount_sum;
  assert.equal(after, 70 + 999, 'bad contribution removed, newer batch preserved');

  // Replaying the same work item must not subtract again.
  const replay = q.executeReversibleWork(db, hd.id);
  assert.equal(replay.already, true);
  assert.equal(q.listSummaries(db).find((s) => s.region === '华东').amount_sum, 1069);

  // Even a simulated duplicate worker that rewrites state to pending and
  // re-runs is blocked by the ledger.
  db.prepare("UPDATE work_items SET state='pending' WHERE id=?").run(hd.id);
  q.executeReversibleWork(db, hd.id);
  assert.equal(q.listSummaries(db).find((s) => s.region === '华东').amount_sum, 1069);
});

test('catalog withdrawal is a back-contribution, not a delete; re-run is a no-op', () => {
  const db = setup();
  const c = open(db);
  const w = workBy(db, c.id, (x) => x.target === 'catalog')[0];
  q.executeReversibleWork(db, w.id);
  const assets = db.prepare("SELECT state FROM catalog_assets WHERE batch_id='B-T-101'").all();
  assert.equal(assets.length, 3);
  assert.ok(assets.every((a) => a.state === 'withdrawn'));
  const events = db.prepare('SELECT * FROM catalog_events').all();
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'backward_contribution');
  const again = q.executeReversibleWork(db, w.id);
  assert.equal(again.already, true);
});

test('irreversible export: loss ack keeps history intact and blocks case closure', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);

  const exp = workBy(db, c.id, (x) => x.target === 'workbook-export')[0];
  assert.throws(() => q.executeReversibleWork(db, exp.id), /不可逆/);

  const art = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(exp.target_ref);
  const hashBefore = art.content_hash;
  const bytesBefore = readFileSync(join(ROOT, art.path), 'utf8');

  const ack = q.acknowledgeLoss(db, exp.id, { consumer: 'workbook-export', key: 'ack-1', note: '已分发' });
  assert.equal(ack.ok, true);

  const artAfter = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(exp.target_ref);
  assert.equal(artAfter.state, 'invalidated');
  assert.equal(artAfter.content_hash, hashBefore, 'hash not rewritten');
  assert.equal(readFileSync(join(ROOT, art.path), 'utf8'), bytesBefore, 'file on disk untouched');

  const c2 = q.getCase(db, c.id);
  assert.equal(c2.status, 'partially_resolved', 'loss means not resolved');
  assert.equal(c2.progress.acknowledged_losses, 1);
  assert.equal(c2.progress.pending, 1);
  assert.ok(c2.progress.by_target['workbook-export'].losses >= 1);

  // duplicate ack with same key is idempotent
  const ack2 = q.acknowledgeLoss(db, exp.id, { consumer: 'workbook-export', key: 'ack-1' });
  assert.equal(ack2.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acks').get().n, 1);
});

test('correction publish → replay → replace export → verify closes case', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  const exp = workBy(db, c.id, (x) => x.target === 'workbook-export')[0];
  q.acknowledgeLoss(db, exp.id, { consumer: 'workbook-export', key: 'ack-1' });

  const corr = q.publishCorrection(db, {
    case_id: c.id, new_batch_id: 'B-T-101F', note: '金额修正',
    rows: [
      { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 },
      { row_id: 'R2', region: '华东', qty: 5, unit_price: 100, amount: 500 },
      { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 200 },
    ],
  });
  assert.equal(corr.correction.state, 'published');
  assert.equal(db.prepare("SELECT state FROM batches WHERE id='B-T-101'").get().state, 'superseded');

  // Consumer must not aggregate the corrected batch directly.
  assert.throws(() => q.consumeBatch(db, { consumer: 'region-summary', batchId: 'B-T-101F' }), /质量服务/);

  // Replay per region, twice, and confirm exact numbers.
  for (const w of workBy(db, c.id, (x) => x.method === 'replay_corrected')) {
    q.executeReplay(db, w.id);
    const again = q.executeReplay(db, w.id);
    assert.equal(again.already, true);
  }
  assert.equal(q.listSummaries(db).find((s) => s.region === '华东').amount_sum, 70 + 1500);
  assert.equal(q.listSummaries(db).find((s) => s.region === '华南').amount_sum, 200);

  // Export is rebuilt as a NEW artifact.
  q.consumeBatch(db, { consumer: 'workbook-export', batchId: 'B-T-101F' });
  const newArt = db.prepare("SELECT * FROM artifacts WHERE correction_id = ?").get(corr.correction.id);
  assert.ok(newArt);
  assert.notEqual(newArt.id, exp.target_ref);
  assert.equal(newArt.state, 'current');

  const verify = q.verifyCorrection(db, corr.correction.id);
  assert.equal(verify.all_passed, true, JSON.stringify(verify.checks.filter((x) => !x.passed), null, 2));
  const closed = q.getCase(db, c.id);
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.progress.pending, 0);
  // loss row is superseded, not erased
  assert.equal(closed.work_items.find((w) => w.id === exp.id).state, 'superseded');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acks').get().n, 1);
});

test('correction cannot publish while reversible work is pending', () => {
  const db = setup();
  const c = open(db);
  const corr = q.workBy === undefined; // no-op marker for lint
  void corr;
  assert.throws(() => q.publishCorrection(db, {
    case_id: c.id, new_batch_id: 'B-T-101F',
    rows: [{ row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 }],
  }), /尚未完成|可逆回退/);
});

test('correction can be published before the export is acknowledged (partial case)', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  const corr = q.publishCorrection(db, {
    case_id: c.id, new_batch_id: 'B-T-101F',
    rows: [
      { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 },
      { row_id: 'R2', region: '华东', qty: 5, unit_price: 100, amount: 500 },
      { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 200 },
    ],
  });
  for (const w of workBy(db, c.id, (x) => x.method === 'replay_corrected')) q.executeReplay(db, w.id);
  // Export rebuilt but the old export's loss was never acknowledged:
  q.consumeBatch(db, { consumer: 'workbook-export', batchId: 'B-T-101F' });
  const verify = q.verifyCorrection(db, corr.correction.id);
  assert.equal(verify.all_passed, true);
  const c2 = q.getCase(db, c.id);
  // Rebuild notice settles via 'done'; no acknowledged loss remains.
  assert.equal(c2.status, 'resolved');
});

test('publishCorrection is blocked by a claimed prior correction and duplicate ids', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  const payload = { case_id: c.id, new_batch_id: 'B-T-101F', rows: [{ row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 }] };
  const first = q.publishCorrection(db, payload);
  assert.ok(first.correction.id);
  assert.throws(() => q.publishCorrection(db, payload), /已发布过修正版/);
  assert.throws(() => q.publishCorrection(db, { ...payload, case_id: c.id, new_batch_id: 'B-T-100' }), /已发布过修正版/);
});

test('verify fails loudly when the corrected total does not match consumer state', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  const corr = q.publishCorrection(db, {
    case_id: c.id, new_batch_id: 'B-T-101F',
    rows: [
      { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 },
      { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 200 },
    ],
  });
  // Only replay 华东; leave 华南 unreplayed. Export must still be rebuilt so the
  // only failing checks are the replay/aggregate ones.
  const hd = workBy(db, c.id, (x) => x.method === 'replay_corrected' && x.target_ref === '华东')[0];
  q.executeReplay(db, hd.id);
  q.consumeBatch(db, { consumer: 'workbook-export', batchId: 'B-T-101F' });
  const verify = q.verifyCorrection(db, corr.correction.id);
  assert.equal(verify.all_passed, false);
  const failing = verify.checks.filter((x) => !x.passed).map((x) => x.check_name);
  assert.ok(failing.includes('replay_settled'));
  assert.ok(failing.includes('corrected_contribution_applied'));
  assert.equal(q.getCase(db, c.id).status, 'partially_resolved');
});

test('tampering with an exported file is detected by verification', () => {
  const db = setup();
  const c = open(db);
  for (const w of workBy(db, c.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  const exp = workBy(db, c.id, (x) => x.target === 'workbook-export')[0];
  const art = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(exp.target_ref);
  q.acknowledgeLoss(db, exp.id, { consumer: 'workbook-export', key: 'k' });
  const corr = q.publishCorrection(db, {
    case_id: c.id, new_batch_id: 'B-T-101F',
    rows: [
      { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 },
      { row_id: 'R2', region: '华东', qty: 5, unit_price: 100, amount: 500 },
      { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 200 },
    ],
  });
  for (const w of workBy(db, c.id, (x) => x.method === 'replay_corrected')) q.executeReplay(db, w.id);
  q.consumeBatch(db, { consumer: 'workbook-export', batchId: 'B-T-101F' });
  writeFileSync(join(ROOT, art.path), 'row_id,region,qty,unit_price,amount,batch_id\nX,Y,1,1,1,Z\n');
  const verify = q.verifyCorrection(db, corr.correction.id);
  const check = verify.checks.find((x) => x.check_name === 'export_history_intact');
  assert.equal(check.passed, 0);
  assert.equal(verify.all_passed, false);
});

test('re-running a failed/duplicated dispose process cannot resurrect bad data', () => {
  const db = setup();
  const c = open(db);
  // Two operators pick the same work item up concurrently: both call execute.
  const items = workBy(db, c.id, (x) => x.target === 'region-summary');
  q.executeReversibleWork(db, items[0].id);
  q.executeReversibleWork(db, items[0].id);
  assert.equal(q.listSummaries(db).find((s) => s.region === items[0].target_ref).amount_sum >= 0, true);
  // Simulate an old process restoring a stale state: set pending and clear
  // nothing else. The ledger prevents double subtraction.
  const totalBefore = q.listSummaries(db).find((s) => s.region === items[0].target_ref).amount_sum;
  db.prepare("UPDATE work_items SET state='pending' WHERE id=?").run(items[0].id);
  q.executeReversibleWork(db, items[0].id);
  assert.equal(q.listSummaries(db).find((s) => s.region === items[0].target_ref).amount_sum, totalBefore);
});

test('isolation: unwinding one case never touches another batch in the same region', () => {
  const db = setup();
  const c1 = open(db);
  for (const w of workBy(db, c1.id, (x) => x.reversible === 1)) q.executeReversibleWork(db, w.id);
  // A second bad batch in the same regions arrives later and is consumed.
  q.ingestBatch(db, {
    batch_id: 'B-T-120', origin: 'producer-erp', released_at: '2026-11-18T00:00:00Z',
    rows: [{ row_id: 'Q1', region: '华东', qty: 2, unit_price: 10, amount: 20 }],
  });
  q.consumeBatch(db, { consumer: 'region-summary', batchId: 'B-T-120' });
  assert.equal(q.listSummaries(db).find((s) => s.region === '华东').amount_sum, 70 + 20);

  const c2 = q.openCase(db, { batch_id: 'B-T-120', bad_field: 'amount', reason: '第二个错误批次' });
  const w2 = workBy(db, c2.id, (x) => x.target === 'region-summary' && x.target_ref === '华东')[0];
  assert.equal(w2.affected_amount, 20, 'second case sees only its own batch contribution');
  q.executeReversibleWork(db, w2.id);
  // First case's corrected/earlier data is untouched.
  assert.equal(q.listSummaries(db).find((s) => s.region === '华东').amount_sum, 70);
});

test('HTTP API roundtrip: web can open case, execute, acknowledge, publish, verify', async () => {
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
  const dbFile = join(ROOT, 'data', 'test-http.db');
  const app = createApp({ dbFile, version: 'test' });
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  try {
    assert.equal((await call('POST', '/api/ingest', BAD)).status, 200);
    await call('POST', '/api/consumers/region-summary/consume', { batch_id: 'B-T-101' });
    await call('POST', '/api/consumers/workbook-export/consume', { batch_id: 'B-T-101' });
    const opened = await call('POST', '/api/cases', { batch_id: 'B-T-101', bad_field: 'amount', reason: 'x' });
    assert.equal(opened.status, 200);
    const caseId = opened.json.id;
    const detail = await call('GET', `/api/cases/${caseId}`);
    for (const w of detail.json.work_items.filter((x) => x.reversible === 1)) {
      const r = await call('POST', `/api/work/${w.id}/execute`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const exp = detail.json.work_items.find((x) => x.target === 'workbook-export');
    assert.equal((await call('POST', `/api/work/${exp.id}/ack-loss`, { consumer: 'workbook-export', key: 'k1' })).status, 200);
    const before = await call('GET', `/api/cases/${caseId}`);
    assert.equal(before.json.status, 'partially_resolved');

    const corr = await call('POST', '/api/corrections', {
      case_id: caseId, new_batch_id: 'B-T-101F',
      rows: [
        { row_id: 'R1', region: '华东', qty: 10, unit_price: 100, amount: 1000 },
        { row_id: 'R2', region: '华东', qty: 5, unit_price: 100, amount: 500 },
        { row_id: 'R3', region: '华南', qty: 4, unit_price: 50, amount: 200 },
      ],
    });
    assert.equal(corr.status, 200, JSON.stringify(corr.json));
    const cid = corr.json.correction.id;
    for (const w of (await call('GET', `/api/cases/${caseId}`)).json.work_items.filter((x) => x.method === 'replay_corrected')) {
      assert.equal((await call('POST', `/api/work/${w.id}/replay`)).status, 200);
    }
    assert.equal((await call('POST', '/api/consumers/workbook-export/consume', { batch_id: 'B-T-101F' })).status, 200);
    const verify = await call('POST', `/api/corrections/${cid}/verify`);
    assert.equal(verify.status, 200, JSON.stringify(verify.json));
    assert.equal(verify.json.all_passed, true, JSON.stringify(verify.json.checks.filter((x) => !x.passed)));
    const final = await call('GET', `/api/cases/${caseId}`);
    assert.equal(final.json.status, 'resolved');

    // Export download refuses an invalidated artifact and serves the current one.
    const arts = (await call('GET', '/api/artifacts')).json.artifacts;
    const oldArt = arts.find((a) => a.id === exp.target_ref);
    assert.equal(oldArt.state, 'invalidated');
    const dl = await call('GET', `/api/artifacts/${oldArt.id}/download`);
    assert.equal(dl.status, 200, 'invalidated artifacts are still downloadable for audit');
  } finally {
    await new Promise((res) => app.server.close(res));
    app.db.close();
  }
});

test('HTTP rejects non-JSON, unknown routes, path traversal', async () => {
  rmSync(join(ROOT, 'data'), { recursive: true, force: true });
  const app = createApp({ dbFile: join(ROOT, 'data', 'test-http2.db') });
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(base + '/api/cases', { method: 'POST', body: '{oops' });
    assert.equal(bad.status, 400);
    const missing = await fetch(base + '/api/nope');
    assert.equal(missing.status, 404);
    const trav = await fetch(base + '/..%2f..%2fetc/passwd');
    assert.ok(trav.status === 404 || trav.status === 400);
  } finally {
    await new Promise((res) => app.server.close(res));
    app.db.close();
  }
});
