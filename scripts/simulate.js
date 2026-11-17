// End-to-end disposal simulation with the awkward conditions spelled out:
//  1. a bad batch already used by both consumers
//  2. a normal new batch arrives mid-disposal and is consumed
//  3. a stale disposal worker re-runs work items after a restart
//  4. the export consumer confirms the loss of an irreversible artifact
//  5. correction published, replayed twice, new export produced, verified
//
// Run: node scripts/simulate.js   (uses a throwaway database)
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, ROOT } from '../src/lib/db.js';
import * as q from '../src/services/quality.js';

const dbFile = join(ROOT, 'data', 'simulate.db');
rmSync(dbFile, { force: true });
rmSync(`${dbFile}-wal`, { force: true });
rmSync(`${dbFile}-shm`, { force: true });
const db = openDb(dbFile);

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`); };
const money = (n) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(n);

const BAD = {
  batch_id: 'B-2026-101', origin: 'producer-erp', released_at: '2026-11-16T07:40:00Z',
  label: '2026-11-16 促销销售明细',
  rows: [
    { row_id: 'P-2001', region: '华东', qty: 40, unit_price: 25, amount: 10000 },
    { row_id: 'P-2002', region: '华东', qty: 12, unit_price: 31, amount: 3720 },
    { row_id: 'P-2003', region: '华南', qty: 20, unit_price: 19.5, amount: 3900 },
    { row_id: 'P-2004', region: '华北', qty: 8, unit_price: 42, amount: 3360 },
  ],
};
const CLEAN = {
  batch_id: 'B-2026-100', origin: 'producer-erp', released_at: '2026-11-15T08:10:00Z',
  label: '2026-11-15 常规销售明细',
  rows: [
    { row_id: 'R-1001', region: '华东', qty: 80, unit_price: 18.5 },
    { row_id: 'R-1002', region: '华南', qty: 55, unit_price: 22 },
  ],
};
const NEW = {
  batch_id: 'B-2026-104', origin: 'producer-erp', released_at: '2026-11-17T02:05:00Z',
  label: '2026-11-17 上午常规销售明细',
  rows: [
    { row_id: 'N-4001', region: '华东', qty: 25, unit_price: 28 },
    { row_id: 'N-4002', region: '华南', qty: 18, unit_price: 21.5 },
    { row_id: 'N-4003', region: '西南', qty: 9, unit_price: 33 },
  ],
};

const snap = () => Object.fromEntries(q.listSummaries(db).map((s) => [s.region, s.amount_sum]));
const show = (label) => line(`${label}: ${Object.entries(snap()).map(([k, v]) => `${k}=${money(v)}`).join('  ')}`);

head('1. 发布并消费');
q.ingestBatch(db, CLEAN);
q.ingestBatch(db, BAD);
for (const b of [CLEAN.batch_id, BAD.batch_id]) {
  q.consumeBatch(db, { consumer: 'region-summary', batchId: b });
  const ex = q.consumeBatch(db, { consumer: 'workbook-export', batchId: b });
  line(`${b} → 汇总已计入；导出 ${ex.artifact.path}`);
}
const before = snap();
show('消费后汇总');

head('2. 发现错误，发起撤销');
const kase = q.openCase(db, {
  batch_id: BAD.batch_id, bad_field: 'amount',
  reason: '上游导出脚本金额多乘 10；两个消费端均已使用。',
});
line(`处置单 ${kase.id} 状态 ${kase.status}，工作项 ${kase.work_items.length} 项`);
for (const w of kase.work_items) {
  line(`  ${w.target.padEnd(16)} ${String(w.target_ref).padEnd(20)} ${w.method.padEnd(20)} ${w.reversible ? '可逆' : '不可逆'} 影响 ${w.affected_rows} 行`);
}

head('3. 处置期间正常新批次到达并被消费');
q.ingestBatch(db, NEW);
q.consumeBatch(db, { consumer: 'region-summary', batchId: NEW.batch_id });
show('新批次加入后');
line('注意：撤销只按行扣减错误批次的贡献，新批次不受影响。');

head('4. 可逆回退 + 旧处置进程重复执行');
const reversible = kase.work_items.filter((w) => w.reversible === 1);
for (const w of reversible) {
  const r = q.executeReversibleWork(db, w.id);
  line(`执行 ${w.target}/${w.target_ref}: ${JSON.stringify(r)}`);
}
show('首次回退后');
line('模拟旧处置进程恢复：把状态改回 pending 并重新执行 ——');
for (const w of reversible) {
  db.prepare("UPDATE work_items SET state='pending' WHERE id=?").run(w.id);
  const r = q.executeReversibleWork(db, w.id);
  line(`  重放 ${w.target}/${w.target_ref}: ${r.already ? '幂等跳过，未重复扣减' : '重复扣减！'}`);
}
show('重放后（应与上一行一致）');

head('5. 不可逆导出确认丢失');
const exp = kase.work_items.find((w) => w.target === 'workbook-export');
const art = db.prepare('SELECT * FROM artifacts WHERE id=?').get(exp.target_ref);
line(`导出文件 ${art.path}（hash ${art.content_hash.slice(0, 12)}…）`);
q.acknowledgeLoss(db, exp.id, { consumer: 'workbook-export', key: `loss:${exp.id}`, note: '已分发至业务方，无法回收' });
const afterLoss = q.getCase(db, kase.id);
line(`确认丢失后处置单状态：${afterLoss.status}，未处理影响 ${afterLoss.progress.pending} 项（不可逆丢失 ${afterLoss.progress.acknowledged_losses}）`);
const reread = db.prepare('SELECT * FROM artifacts WHERE id=?').get(exp.target_ref);
line(`原文件仍在：状态 ${reread.state}，hash 未变：${reread.content_hash === art.content_hash}`);

head('6. 发布修正版并重放');
const correctedRows = BAD.rows.map((r) => ({ ...r, amount: Math.round(r.qty * r.unit_price * 100) / 100 }));
const corr = q.publishCorrection(db, {
  case_id: kase.id, new_batch_id: 'B-2026-101F', label: '2026-11-16 促销销售明细（修正版）',
  note: '金额按 qty × unit_price 修正',
  rows: correctedRows,
});
line(`修正批次 ${corr.batch.id}，重放区域 ${corr.replay_regions.join('、')}`);
for (const w of q.getCase(db, kase.id).work_items.filter((x) => x.method === 'replay_corrected')) {
  const a = q.executeReplay(db, w.id);
  const b = q.executeReplay(db, w.id);
  line(`重放 ${w.target_ref}: 首次 ${a.replayed ?? 0} 行 / 再次 ${b.already ? '幂等跳过' : '重复回补！'}`);
}
show('修正版回补后');

head('7. 消费端生成修正版导出并核对');
const newExport = q.consumeBatch(db, { consumer: 'workbook-export', batchId: corr.batch.id });
line(`新导出 ${newExport.artifact.path}（${newExport.artifact.state}）`);
const verify = q.verifyCorrection(db, corr.correction.id);
for (const c of verify.checks) {
  line(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.check_name.padEnd(32)} ${c.scope.padEnd(18)} 期望 ${c.expected} / 实际 ${c.actual}`);
}
const final = q.getCase(db, kase.id);
line();
line(`核对${verify.all_passed ? '通过' : '未通过'}；处置单状态：${final.status}`);
line(`已处理 ${final.progress.settled}/${final.progress.total}，未处理 ${final.progress.pending}`);
line(`原导出（失效但保留）：${db.prepare('SELECT path,state FROM artifacts WHERE id=?').get(art.id).state}`);
line(`修正确认丢失工作项状态：${db.prepare('SELECT state FROM work_items WHERE id=?').get(exp.id).state}`);
show('最终汇总（应等于 有效批次合计）');
line(`有效批次合计：${money(db.prepare("SELECT SUM(amount) s FROM batch_rows r JOIN batches b ON b.id=r.batch_id WHERE b.state='active'").get().s)}`);
db.close();
