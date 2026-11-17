// Seed a realistic operational scenario into a fresh database.
//
// Story: batch B-2026-101 published yesterday with an amount field that was
// overstated (unit price was correct; the published amount was 10x). Two
// downstream consumers already used it: the regional summary aggregate and a
// workbook export. A quality case is opened; meanwhile a new normal batch
// B-2026-104 is published and consumed, and an earlier clean batch remains.
import { openDb, ROOT } from '../src/lib/db.js';
import * as q from '../src/services/quality.js';
import { join } from 'node:path';

const D = (s) => new Date(s).toISOString();

const CLEAN_BATCH = {
  batch_id: 'B-2026-100',
  label: '2026-11-15 常规销售明细',
  origin: 'producer-erp',
  released_at: D('2026-11-15T08:10:00Z'),
  rows: [
    { row_id: 'R-1001', region: '华东', qty: 80, unit_price: 18.5 },
    { row_id: 'R-1002', region: '华南', qty: 55, unit_price: 22.0 },
    { row_id: 'R-1003', region: '华北', qty: 30, unit_price: 26.4 },
  ],
};

const BAD_BATCH = {
  batch_id: 'B-2026-101',
  label: '2026-11-16 促销销售明细',
  origin: 'producer-erp',
  released_at: D('2026-11-16T07:40:00Z'),
  note: '金额字段在导出脚本中多乘 10',
  rows: [
    { row_id: 'P-2001', region: '华东', qty: 40, unit_price: 25.0, amount: 10000.0 },
    { row_id: 'P-2002', region: '华东', qty: 12, unit_price: 31.0, amount: 3720.0 },
    { row_id: 'P-2003', region: '华南', qty: 20, unit_price: 19.5, amount: 3900.0 },
    { row_id: 'P-2004', region: '华北', qty: 8, unit_price: 42.0, amount: 3360.0 },
  ],
};

const NEW_BATCH = {
  batch_id: 'B-2026-104',
  label: '2026-11-17 上午常规销售明细',
  origin: 'producer-erp',
  released_at: D('2026-11-17T02:05:00Z'),
  rows: [
    { row_id: 'N-4001', region: '华东', qty: 25, unit_price: 28.0 },
    { row_id: 'N-4002', region: '华南', qty: 18, unit_price: 21.5 },
    { row_id: 'N-4003', region: '西南', qty: 9, unit_price: 33.0 },
  ],
};

export function seed(db = openDb()) {
  if (db.prepare('SELECT COUNT(*) n FROM batches').get().n > 0) {
    return { seeded: false, reason: '数据库已有批次，未重复注入' };
  }
  q.ingestBatch(db, CLEAN_BATCH);
  q.ingestBatch(db, BAD_BATCH);

  // Both consumers pick up the clean batch and the bad batch.
  for (const b of ['B-2026-100', 'B-2026-101']) {
    q.consumeBatch(db, { consumer: 'region-summary', batchId: b });
    q.consumeBatch(db, { consumer: 'workbook-export', batchId: b });
  }

  const kase = q.openCase(db, {
    batch_id: 'B-2026-101',
    bad_field: 'amount',
    reason: '上游导出脚本把金额字段多乘 10；下游华东/华南/华北汇总与工作簿导出均已使用。',
  });

  // A normal batch arrives while the case is being handled.
  q.ingestBatch(db, NEW_BATCH);
  q.consumeBatch(db, { consumer: 'region-summary', batchId: 'B-2026-104' });

  return { seeded: true, case_id: kase.id, db_path: join(ROOT, 'data', 'revocation.db') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.DB_FILE || join(ROOT, 'data', 'revocation.db'));
  const out = seed(db);
  console.log(JSON.stringify(out, null, 2));
  db.close();
}
