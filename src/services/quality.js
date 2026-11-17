// Domain logic shared by the HTTP layer, the CLI simulator and the tests.
//
// Invariants this module protects:
//  * Reversible aggregates are never edited in place by arithmetic on a stale
//    snapshot. Consumption rows carry a state, and a region's summary is
//    recomputed from the rows that are still `applied`. A retried or replayed
//    job therefore cannot subtract twice.
//  * summary_ledger additionally records every movement, unique per
//    (work_item_id, region), so a replayed worker is a no-op even if it arrives
//    with a stale in-memory plan.
//  * Artifacts (exports) are immutable files. They are frozen, invalidated and
//    superseded by a NEW artifact; they are never edited or deleted.
//  * Publishing a correction is idempotent; replaying corrected rows is guarded
//    by its own work item + ledger rows and by the corrected-batch kind rule.
//  * Every state transition writes an event row so the UI can explain the
//    timeline without re-deriving it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, uid, nowIso, round2, fingerprint, sha256 } from '../lib/util.js';
import { tx, setMeta, getMeta, ROOT } from '../lib/db.js';

export const CONSUMERS = {
  'region-summary': { kind: 'aggregate', reversible: 1, method: 'backward_contribution' },
  'workbook-export': { kind: 'artifact', reversible: 0, method: 'rebuild_notice' },
};

// Work-item lifecycle:
//   pending ─┬─ done              reversible work executed / replay done / rebuild delivered
//            ├─ superseded        acknowledged loss closed by a verified correction
//            ├─ acknowledged_loss consumer confirmed an irreversible artifact is out there
//            └─ failed            operator decided it cannot proceed; impact stays visible
//
// `acknowledged_loss` and `failed` are terminal observations but NOT handled
// impacts: the bad data still exists downstream. Only `done` and `superseded`
// count as handled, so a case cannot close while an export loss is merely known.
export const HANDLED_WORK_STATES = new Set(['done', 'superseded']);
export const OPEN_WORK_STATES = new Set(['pending', 'acknowledged_loss', 'failed']);
export const TERMINAL_WORK_STATES = new Set(['done', 'superseded', 'acknowledged_loss', 'failed']);
const EXPORT_DIR = join(ROOT, 'data', 'exports');

/* ═══════════════════════════════ batches ═══════════════════════════════ */

export function listBatches(db) {
  return db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM batch_rows r WHERE r.batch_id = b.id) AS row_count,
      (SELECT COALESCE(SUM(amount), 0) FROM batch_rows r WHERE r.batch_id = b.id) AS total_amount
    FROM batches b ORDER BY b.released_at DESC, b.id DESC
  `).all().map((b) => ({ ...b, total_amount: round2(b.total_amount) }));
}

export function getBatch(db, id) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  if (!batch) throw new ApiError(404, `批次 ${id} 不存在`);
  batch.rows = db.prepare('SELECT * FROM batch_rows WHERE batch_id = ? ORDER BY row_id').all(id);
  return batch;
}

/**
 * Ingest a producer batch. Rows are validated before any write. Idempotent by
 * batch id when the payload is identical.
 */
export function ingestBatch(db, input) {
  const id = String(input.batch_id ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(id)) {
    throw new ApiError(400, 'batch_id 需为 3-64 位字母、数字、点、下划线或短横线');
  }
  if (db.prepare('SELECT 1 FROM batches WHERE id = ?').get(id)) {
    const existing = getBatch(db, id);
    const same = fingerprint(existing.rows.map(rowFingerprint)) === fingerprint((input.rows ?? []).map(rowFingerprint));
    if (same) return { batch: existing, duplicate: true };
    throw new ApiError(409, `批次 ${id} 已存在且内容不同`);
  }
  const origin = String(input.origin ?? '').trim();
  if (!origin) throw new ApiError(400, 'origin 不能为空');
  if (input.kind === 'corrected') throw new ApiError(400, '修正批次只能通过修正发布流程创建');
  const rows = normalizeRows(input.rows);
  if (rows.length === 0) throw new ApiError(400, '批次至少需要一行数据');
  const releasedAt = input.released_at ? new Date(input.released_at) : new Date();
  if (Number.isNaN(releasedAt.getTime())) throw new ApiError(400, 'released_at 不是合法时间');

  return tx(db, () => {
    db.prepare(`INSERT INTO batches(id, label, origin, released_at, state, kind, note)
                VALUES(?, ?, ?, ?, 'active', 'normal', ?)`)
      .run(id, String(input.label ?? id), origin, releasedAt.toISOString(), String(input.note ?? ''));
    insertRows(db, id, rows);
    return { batch: getBatch(db, id), duplicate: false };
  });
}

function insertRows(db, batchId, rows) {
  const insertRow = db.prepare('INSERT INTO batch_rows(batch_id, row_id, region, qty, unit_price, amount) VALUES(?, ?, ?, ?, ?, ?)');
  const insertAsset = db.prepare("INSERT INTO catalog_assets(id, batch_id, row_id, region, state) VALUES(?, ?, ?, ?, 'current')");
  for (const r of rows) {
    insertRow.run(batchId, r.row_id, r.region, r.qty, r.unit_price, r.amount);
    insertAsset.run(`asset:${batchId}:${r.row_id}`, batchId, r.row_id, r.region);
  }
}

function rowFingerprint(r) {
  return [r.row_id, r.region, r.qty, r.unit_price, r.amount].join('|');
}

export function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new ApiError(400, 'rows 必须是数组');
  if (rows.length > 5000) throw new ApiError(400, '单批次最多 5000 行');
  const seen = new Set();
  return rows.map((raw, i) => {
    const row_id = String(raw?.row_id ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(row_id)) throw new ApiError(400, `第 ${i + 1} 行 row_id 非法`);
    if (seen.has(row_id)) throw new ApiError(400, `row_id ${row_id} 重复`);
    seen.add(row_id);
    const region = String(raw?.region ?? '').trim();
    if (!/^[\p{L}\p{N} _-]{1,40}$/u.test(region)) throw new ApiError(400, `第 ${i + 1} 行 region 非法`);
    const qty = Number(raw?.qty);
    const unit_price = Number(raw?.unit_price);
    const amount = raw?.amount === undefined || raw?.amount === null || raw?.amount === '' ? qty * unit_price : Number(raw.amount);
    if (!Number.isInteger(qty) || qty < 0 || qty > 1e7) throw new ApiError(400, `第 ${i + 1} 行 qty 非法`);
    if (!Number.isFinite(unit_price) || unit_price < 0 || unit_price > 1e9) throw new ApiError(400, `第 ${i + 1} 行 unit_price 非法`);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new ApiError(400, `第 ${i + 1} 行 amount 非法`);
    return { row_id, region, qty, unit_price: round2(unit_price), amount: round2(amount) };
  });
}

/* ═══════════════════════ downstream materialization ════════════════════ */

/**
 * Consumer picks up an active batch it has not consumed yet.
 *  - region-summary: per-row aggregate contribution (reversible)
 *  - workbook-export: one immutable artifact (irreversible)
 * Corrected batches may only be exported here; their aggregate contribution is
 * replayed explicitly by the quality service so it is ledgered and verified.
 */
export function consumeBatch(db, { consumer, batchId }) {
  const cfg = CONSUMERS[consumer];
  if (!cfg) throw new ApiError(400, `未知消费端 ${consumer}`);
  const batch = getBatch(db, batchId);
  if (batch.state !== 'active') {
    throw new ApiError(409, `批次 ${batchId} 状态为 ${batch.state}，消费端不得继续消费`);
  }
  if (cfg.reversible) {
    if (batch.kind === 'corrected') {
      throw new ApiError(409, '修正批次的可逆汇总由质量服务按处置单重放回补，消费端不得直接汇总');
    }
    const pending = db.prepare(`
      SELECT r.* FROM batch_rows r WHERE r.batch_id = ?
      AND NOT EXISTS (SELECT 1 FROM consumptions c
        WHERE c.batch_id = r.batch_id AND c.row_id = r.row_id AND c.consumer = ?)
    `).all(batchId, consumer);
    if (!pending.length) return { consumer, batch_id: batchId, applied: 0, already: true };
    return tx(db, () => {
      const regions = new Set();
      for (const r of pending) {
        db.prepare(`
          INSERT INTO consumptions(id, consumer, consumer_kind, batch_id, row_id, region, amount, qty, reversible, state)
          VALUES(?, ?, 'aggregate', ?, ?, ?, ?, ?, 1, 'applied')
        `).run(uid('cons'), consumer, batchId, r.row_id, r.region, r.amount, r.qty);
        regions.add(r.region);
      }
      for (const region of regions) recomputeRegion(db, region);
      return { consumer, batch_id: batchId, applied: pending.length, already: false, regions: [...regions] };
    });
  }
  return produceExport(db, { batchId });
}

/**
 * Produce an immutable export artifact. Content is written once and hashed;
 * the artifact row records the hash so later tampering is detectable.
 */
export function produceExport(db, { batchId }) {
  const batch = getBatch(db, batchId);
  const existing = db.prepare(`
    SELECT DISTINCT a.* FROM artifacts a JOIN consumptions c ON c.artifact_id = a.id
    WHERE c.batch_id = ? AND a.state = 'current' AND a.produced_by = 'consumer'
  `).get(batchId);
  if (existing) return { artifact: existing, already: true, consumer: 'workbook-export' };

  const correction = db.prepare('SELECT * FROM corrections WHERE new_batch_id = ?').get(batchId);
  const artifactId = uid('art');
  const filename = `export-${batchId}-${artifactId.slice(4)}.csv`;
  const rel = `data/exports/${filename}`;
  const lines = ['row_id,region,qty,unit_price,amount,batch_id'];
  for (const r of batch.rows) {
    lines.push([r.row_id, r.region, r.qty, r.unit_price, r.amount, batchId].map(csvCell).join(','));
  }
  const content = lines.join('\n') + '\n';
  const hash = sha256(content);
  mkdirSync(EXPORT_DIR, { recursive: true });
  // wx: never overwrite an existing artifact file.
  writeFileSync(join(EXPORT_DIR, filename), content, { flag: 'wx' });
  const producedAt = nowIso();
  return tx(db, () => {
    db.prepare(`INSERT INTO artifacts(id, path, produced_at, produced_by, content_hash, row_count, state, correction_id, note)
                VALUES(?, ?, ?, 'consumer', ?, ?, 'current', ?, ?)`)
      .run(artifactId, rel, producedAt, hash, batch.rows.length, correction?.id ?? null,
        correction ? `修正版导出（处置单 ${correction.case_id}）` : '正常批导出');
    for (const r of batch.rows) {
      db.prepare(`
        INSERT INTO consumptions(id, consumer, consumer_kind, batch_id, row_id, region, amount, qty, reversible, state, artifact_id)
        VALUES(?, 'workbook-export', 'artifact', ?, ?, ?, ?, ?, 0, 'applied', ?)
      `).run(uid('cons'), batchId, r.row_id, r.region, r.amount, r.qty, artifactId);
    }
    if (correction) {
      // The consumer has rebuilt: settle the pending rebuild notices. A notice
      // already confirmed as a loss stays put until verify supersedes it.
      const notices = db.prepare(`
        SELECT * FROM work_items WHERE case_id = ? AND method = 'rebuild_notice' AND state = 'pending'
      `).all(correction.case_id);
      for (const w of notices) {
        settleWork(db, w.id, 'done', `消费端已重新导出 ${rel}（新文件，旧文件保持不可变）`);
      }
      if (notices.length) refreshCaseStatus(db, correction.case_id);
    }
    return {
      artifact: db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId),
      already: false, consumer: 'workbook-export',
    };
  });
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Recompute a region's reversible summary from applied consumption rows.
 * This is the single writer of consumer_summaries for the aggregate consumer,
 * which makes unwinding and replay idempotent by construction.
 */
export function recomputeRegion(db, region) {
  const agg = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amount_sum, COALESCE(SUM(qty), 0) AS qty_sum, COUNT(*) AS contributions
    FROM consumptions
    WHERE consumer = 'region-summary' AND reversible = 1 AND state = 'applied' AND region = ?
  `).get(region);
  db.prepare(`
    INSERT INTO consumer_summaries(region, amount_sum, qty_sum, contributions)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(region) DO UPDATE SET
      amount_sum = excluded.amount_sum,
      qty_sum = excluded.qty_sum,
      contributions = excluded.contributions
  `).run(region, round2(agg.amount_sum), agg.qty_sum, agg.contributions);
  return round2(agg.amount_sum);
}

export function listSummaries(db) {
  return db.prepare('SELECT * FROM consumer_summaries ORDER BY region').all()
    .map((s) => ({ ...s, amount_sum: round2(s.amount_sum) }));
}

export function listArtifacts(db) {
  return db.prepare('SELECT * FROM artifacts ORDER BY produced_at DESC, id DESC').all();
}

/* ═══════════════════════════════ cases ════════════════════════════════ */

export function listCases(db) {
  return db.prepare('SELECT * FROM cases ORDER BY opened_at DESC').all()
    .map((c) => ({ ...c, progress: caseProgress(db, c.id) }));
}

export function getCase(db, id) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) throw new ApiError(404, `处置单 ${id} 不存在`);
  return {
    ...c,
    batch: db.prepare('SELECT id, label, origin, released_at, state, kind, total_amount FROM (SELECT b.*, (SELECT COALESCE(SUM(amount),0) FROM batch_rows r WHERE r.batch_id = b.id) AS total_amount FROM batches b) WHERE id = ?').get(c.batch_id),
    progress: caseProgress(db, c.id),
    work_items: listWorkItems(db, c.id),
    events: db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY seq').all(c.id),
    corrections: db.prepare('SELECT * FROM corrections WHERE case_id = ? ORDER BY created_at').all(c.id)
      .map((x) => ({
        ...x,
        checks: db.prepare('SELECT * FROM correction_checks WHERE correction_id = ? ORDER BY checked_at, id').all(x.id),
      })),
    artifacts: db.prepare(`
      SELECT DISTINCT a.*, c.reversible FROM artifacts a JOIN consumptions c ON c.artifact_id = a.id
      WHERE c.batch_id = ? OR a.correction_id IN (SELECT id FROM corrections WHERE case_id = ?)
      ORDER BY a.produced_at DESC
    `).all(c.batch_id, c.id),
  };
}

/**
 * Open a revocation case for a batch with a wrong field, and fan out the
 * propagation work from actual consumption records (not assumptions).
 */
export function openCase(db, input) {
  const batchId = String(input.batch_id ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  const badField = String(input.bad_field ?? '').trim();
  if (!reason || reason.length > 1000) throw new ApiError(400, 'reason 不能为空且不超过 1000 字');
  if (!/^(amount|qty|unit_price|region|row_id)$/.test(badField)) {
    throw new ApiError(400, 'bad_field 必须是 amount / qty / unit_price / region / row_id 之一');
  }
  const batch = getBatch(db, batchId);
  if (batch.kind !== 'normal') throw new ApiError(400, '只能对普通批次发起撤销');
  if (batch.state !== 'active') throw new ApiError(409, `批次当前状态为 ${batch.state}，不能重复发起撤销`);
  const existing = db.prepare("SELECT id FROM cases WHERE batch_id = ? AND status != 'resolved'").get(batchId);
  if (existing) throw new ApiError(409, `该批次已有未结处置单 ${existing.id}`);

  return tx(db, () => {
    const caseId = uid('case');
    const at = nowIso();
    db.prepare(`INSERT INTO cases(id, batch_id, reason, bad_field, status, opened_at, created_by)
                VALUES(?, ?, ?, ?, 'propagating', ?, ?)`)
      .run(caseId, batchId, reason, badField, at, String(input.created_by ?? 'quality-operator').slice(0, 80));
    db.prepare("UPDATE batches SET state = 'invalidated', version = version + 1 WHERE id = ?").run(batchId);
    addCaseEvent(db, caseId, 'opened', `发现字段 ${badField} 错误：${reason}`);

    // Catalog: backwards contribution for every row; reversible and immediate.
    const assets = db.prepare('SELECT id FROM catalog_assets WHERE batch_id = ? ORDER BY row_id').all(batchId);
    for (const asset of assets) {
      db.prepare("UPDATE catalog_assets SET state = 'flagged', version = version + 1 WHERE id = ?").run(asset.id);
    }
    insertWork(db, {
      caseId, target: 'catalog', targetRef: `batch:${batchId}`,
      method: 'backward_contribution', reversible: 1, state: 'pending',
      idempotencyKey: `catalog:${caseId}:${batchId}`,
      affectedRows: assets.length,
      affectedAmount: round2(batch.rows.reduce((s, r) => s + r.amount, 0)),
    });
    addCaseEvent(db, caseId, 'work_created', `数据目录：${assets.length} 个资产标记为 flagged，等待反向贡献撤回`);

    // Reversible aggregate consumers: one work item per affected region so a
    // retry scopes to a single region and cannot double-subtract.
    const aggregates = db.prepare(`
      SELECT consumer, region, COUNT(*) AS rows, SUM(amount) AS amount
      FROM consumptions WHERE batch_id = ? AND reversible = 1 AND state = 'applied'
      GROUP BY consumer, region ORDER BY consumer, region
    `).all(batchId);
    for (const a of aggregates) {
      insertWork(db, {
        caseId, target: a.consumer, targetRef: a.region,
        method: 'backward_contribution', reversible: 1, state: 'pending',
        idempotencyKey: `unwind:${caseId}:${a.consumer}:${a.region}`,
        affectedRows: a.rows, affectedAmount: round2(a.amount),
      });
    }
    if (aggregates.length) {
      addCaseEvent(db, caseId, 'work_created',
        `可逆汇总：${aggregates.map((a) => `${a.consumer}/${a.region}`).join('、')} 需反向贡献（可直接扣减）`);
    }

    // Irreversible artifacts: rebuild notice only, never an in-place edit.
    const artifacts = db.prepare(`
      SELECT DISTINCT a.id, a.path, a.row_count FROM artifacts a
      JOIN consumptions c ON c.artifact_id = a.id
      WHERE c.batch_id = ? AND c.reversible = 0 AND a.state = 'current'
    `).all(batchId);
    for (const art of artifacts) {
      // Mark the exported file as invalid the moment the case opens. It stays
      // on disk untouched: invalidation is a status, not an edit.
      db.prepare("UPDATE artifacts SET state = 'invalidated' WHERE id = ? AND state = 'current'").run(art.id);
      insertWork(db, {
        caseId, target: 'workbook-export', targetRef: art.id,
        method: 'rebuild_notice', reversible: 0, state: 'pending',
        idempotencyKey: `rebuild:${caseId}:${art.id}`,
        affectedRows: art.row_count,
        affectedAmount: round2(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM consumptions WHERE artifact_id = ?').get(art.id).s),
      });
      addCaseEvent(db, caseId, 'work_created', `不可逆导出：${art.path} 只能通知重建，原文件不允许修改`);
    }

    if (!aggregates.length && !artifacts.length) {
      addCaseEvent(db, caseId, 'note', '该批次尚无下游消费记录，仅需处理数据目录');
    }
    refreshCaseStatus(db, caseId);
    return getCase(db, caseId);
  });
}

function insertWork(db, w) {
  const id = uid('wrk');
  db.prepare(`
    INSERT INTO work_items(id, case_id, target, target_ref, method, reversible, state,
      idempotency_key, affected_rows, affected_amount, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, w.caseId, w.target, w.targetRef, w.method, w.reversible, w.state,
    w.idempotencyKey, w.affectedRows ?? 0, round2(w.affectedAmount ?? 0), nowIso());
  addWorkEvent(db, id, 'created', `方法 ${w.method}，影响 ${w.affectedRows ?? 0} 行`);
  return id;
}

export function addCaseEvent(db, caseId, kind, detail) {
  db.prepare('INSERT INTO case_events(case_id, at, kind, detail) VALUES(?, ?, ?, ?)')
    .run(caseId, nowIso(), kind, String(detail));
}

export function addWorkEvent(db, workId, kind, detail) {
  db.prepare('INSERT INTO work_events(work_item_id, at, kind, detail) VALUES(?, ?, ?, ?)')
    .run(workId, nowIso(), kind, String(detail));
}

export function listWorkItems(db, caseId) {
  return db.prepare('SELECT * FROM work_items WHERE case_id = ? ORDER BY target, target_ref').all(caseId)
    .map((w) => ({
      ...w,
      affected_amount: round2(w.affected_amount),
      events: db.prepare('SELECT * FROM work_events WHERE work_item_id = ? ORDER BY seq').all(w.id),
    }));
}

export function caseProgress(db, caseId) {
  const items = db.prepare('SELECT target, target_ref, reversible, state FROM work_items WHERE case_id = ?').all(caseId);
  const total = items.length;
  const settled = items.filter((w) => HANDLED_WORK_STATES.has(w.state)).length;
  const pending = items.filter((w) => OPEN_WORK_STATES.has(w.state)).length;
  const acknowledgedLosses = items.filter((w) => w.state === 'acknowledged_loss').length;
  const failed = items.filter((w) => w.state === 'failed').length;
  const byTarget = {};
  for (const w of items) {
    const t = byTarget[w.target] ??= {
      total: 0, settled: 0, pending: 0,
      reversible: w.reversible === 1, losses: 0, failed: 0,
    };
    t.total += 1;
    if (HANDLED_WORK_STATES.has(w.state)) t.settled += 1;
    else t.pending += 1;
    if (w.state === 'acknowledged_loss') t.losses += 1;
    if (w.state === 'failed') t.failed += 1;
  }
  return { total, settled, pending, acknowledged_losses: acknowledgedLosses, failed, by_target: byTarget };
}

export function refreshCaseStatus(db, caseId) {
  const progress = caseProgress(db, caseId);
  const row = db.prepare('SELECT status FROM cases WHERE id = ?').get(caseId);
  const status = progress.pending === 0 ? 'resolved'
    : progress.settled === 0 ? 'propagating'
    : 'partially_resolved';
  if (status === row.status) return status;
  db.prepare('UPDATE cases SET status = ?, closed_at = ? WHERE id = ?')
    .run(status, status === 'resolved' ? nowIso() : null, caseId);
  addCaseEvent(db, caseId, 'status', status === 'resolved'
    ? '所有影响已核销，处置单关闭'
    : `状态更新为 ${status}，仍有 ${progress.pending} 项影响未处理`);
  return status;
}

/* ══════════════════════════ reversible work ════════════════════════════ */

/** Execute one pending reversible work item. Safe to call twice. */
export function executeReversibleWork(db, workId) {
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId);
  if (!w) throw new ApiError(404, '工作项不存在');
  if (w.reversible !== 1) throw new ApiError(400, '不可逆导出项不能反向贡献，只能通知消费端重建');
  if (w.method === 'replay_corrected') {
    // A replay must go through executeReplay; unwinding here would settle the
    // work item without restoring the corrected rows.
    throw new ApiError(400, '修正版重放请调用重放接口');
  }
  if (w.state === 'done') return { ok: true, already: true, work_id: workId };
  if (w.state !== 'pending') throw new ApiError(409, `工作项状态为 ${w.state}，不能执行反向贡献`);
  return tx(db, () => {
    if (w.target === 'catalog') return applyCatalogWithdrawal(db, w);
    return applySummaryUnwind(db, w);
  });
}

function applyCatalogWithdrawal(db, w) {
  const batchId = w.target_ref.startsWith('batch:') ? w.target_ref.slice(6) : null;
  if (!batchId) throw new ApiError(500, '目录工作项缺少批次引用');
  const assets = db.prepare("SELECT id FROM catalog_assets WHERE batch_id = ? AND state = 'flagged'").all(batchId);
  const at = nowIso();
  for (const a of assets) {
    db.prepare("UPDATE catalog_assets SET state = 'withdrawn', version = version + 1 WHERE id = ?").run(a.id);
    db.prepare('INSERT INTO catalog_events(asset_id, kind, reason, at) VALUES(?, ?, ?, ?)')
      .run(a.id, 'backward_contribution', `处置单 ${w.case_id} 撤回错误批次`, at);
  }
  settleWork(db, w.id, 'done', assets.length
    ? `已撤回 ${assets.length} 个目录资产`
    : '目录资产已撤回（幂等重放）');
  refreshCaseStatus(db, w.case_id);
  return { ok: true, withdrawn: assets.length, already: assets.length === 0 };
}

function applySummaryUnwind(db, w) {
  const c = db.prepare('SELECT batch_id FROM cases WHERE id = ?').get(w.case_id);
  const ledger = db.prepare('SELECT 1 FROM summary_ledger WHERE work_item_id = ? AND region = ?').get(w.id, w.target_ref);
  if (ledger) {
    settleWork(db, w.id, 'done', '该区域反向贡献已入账（幂等重放），未重复扣减');
    refreshCaseStatus(db, w.case_id);
    return { ok: true, already: true };
  }
  const rows = db.prepare(`
    SELECT * FROM consumptions
    WHERE batch_id = ? AND consumer = ? AND region = ? AND reversible = 1 AND state = 'applied'
  `).all(c.batch_id, w.target, w.target_ref);
  let amount = 0;
  let qty = 0;
  for (const r of rows) {
    amount += r.amount;
    qty += r.qty;
    db.prepare("UPDATE consumptions SET state = 'unwound', version = version + 1 WHERE id = ?").run(r.id);
  }
  db.prepare('INSERT INTO summary_ledger(work_item_id, region, amount_delta, qty_delta, kind, at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(w.id, w.target_ref, round2(-amount), -qty, 'unwind', nowIso());
  // Derived from applied rows, not from a pre-read total: cannot go negative
  // and cannot include rows belonging to newer batches.
  recomputeRegion(db, w.target_ref);
  settleWork(db, w.id, 'done', rows.length
    ? `已反向贡献 ${rows.length} 行，扣减金额 ${round2(amount)}、数量 ${qty}`
    : '该批次在此区域已无剩余贡献（可能为幂等重放）');
  refreshCaseStatus(db, w.case_id);
  return { ok: true, unwound: rows.length, amount: round2(amount), qty, already: rows.length === 0 };
}

function settleWork(db, workId, state, detail, error = null) {
  db.prepare('UPDATE work_items SET state = ?, updated_at = ?, last_error = ? WHERE id = ?')
    .run(state, nowIso(), error, workId);
  addWorkEvent(db, workId, state, detail);
}

/* ═════════════════════════ irreversible work ═══════════════════════════ */

/**
 * A consumer confirms an irreversible artifact cannot be recalled. The artifact
 * stays on disk untouched; it is invalidated, its consumption rows frozen, and
 * the loss remains visible in the case until a corrected export is verified.
 */
export function acknowledgeLoss(db, workId, { consumer, note, key } = {}) {
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId);
  if (!w) throw new ApiError(404, '工作项不存在');
  if (w.target !== 'workbook-export' || w.reversible !== 0) {
    throw new ApiError(400, '只有不可逆导出项可以确认丢失');
  }
  if (w.state === 'acknowledged_loss') {
    return { ok: true, already: true, work: db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId) };
  }
  if (w.state === 'failed') throw new ApiError(409, '该工作项已失败，需重新发起');
  if (w.state === 'done') throw new ApiError(409, '该工作项已完成');
  const consumerName = String(consumer ?? '').trim();
  if (consumerName !== 'workbook-export') throw new ApiError(400, 'consumer 必须是 workbook-export');
  const ackKey = String(key ?? '').trim();
  if (!ackKey || ackKey.length > 200) throw new ApiError(400, '需要幂等键 key（<=200 字符）');
  const targetArtifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(w.target_ref);
  if (!targetArtifact) {
    throw new ApiError(400, '该工作项不是具体的导出文件（修正版重建通知不能确认丢失）');
  }
  const at = nowIso();
  return tx(db, () => {
    const prior = db.prepare('SELECT * FROM acks WHERE key = ?').get(ackKey);
    if (prior && prior.work_item_id !== workId) {
      throw new ApiError(409, `幂等键 ${ackKey} 已被其他工作项使用`);
    }
    db.prepare(`INSERT OR IGNORE INTO acks(key, work_item_id, consumer, outcome, payload, received_at)
                VALUES(?, ?, ?, 'loss_confirmed', ?, ?)`)
      .run(ackKey, workId, consumerName, JSON.stringify({ note: String(note ?? '').slice(0, 500) }), at);
    const artifactId = w.target_ref;
    const art = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId);
    if (art && art.state === 'current') {
      db.prepare("UPDATE artifacts SET state = 'invalidated' WHERE id = ?").run(art.id);
    }
    db.prepare(`
      UPDATE consumptions SET state = 'frozen', version = version + 1
      WHERE artifact_id = ? AND state = 'applied'
    `).run(artifactId);
    settleWork(db, workId, 'acknowledged_loss',
      `消费端确认 ${artifactId} 无法回收（不可逆导出），影响保持未处理，等待修正版核对`);
    addCaseEvent(db, w.case_id, 'loss',
      `导出 ${art?.path ?? artifactId} 确认不可逆、无法撤回；在修正版导出核对前计入“未处理影响”`);
    refreshCaseStatus(db, w.case_id);
    return { ok: true, already: Boolean(prior), work: db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId) };
  });
}

/** Explicit failure path: records why without pretending the impact is handled. */
export function failWork(db, workId, reason) {
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId);
  if (!w) throw new ApiError(404, '工作项不存在');
  if (HANDLED_WORK_STATES.has(w.state)) {
    throw new ApiError(409, `工作项已完成（${w.state}），不能标记失败`);
  }
  tx(db, () => {
    settleWork(db, workId, 'failed', `人工标记失败：${String(reason ?? '未说明')}`, String(reason ?? ''));
    refreshCaseStatus(db, w.case_id);
  });
  return db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId);
}

/* ══════════════════════════ corrected release ══════════════════════════ */

/**
 * Publish a corrected batch for a case whose undo work is finished, and build
 * the replay work. Exports get a NEW rebuild notice: the corrected export is a
 * new artifact, never an edit of the invalidated one.
 */
export function publishCorrection(db, input) {
  const caseId = String(input.case_id ?? '').trim();
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!c) throw new ApiError(404, `处置单 ${caseId} 不存在`);
  if (db.prepare('SELECT 1 FROM corrections WHERE case_id = ?').get(caseId)) {
    throw new ApiError(409, '该处置单已发布过修正版');
  }
  if (c.status === 'propagating') throw new ApiError(409, '撤销传播尚未完成，不能发布修正版');
  const blocking = db.prepare(`
    SELECT COUNT(*) n FROM work_items
    WHERE case_id = ? AND reversible = 1 AND state != 'done'
  `).get(caseId).n;
  if (blocking > 0) throw new ApiError(409, `仍有 ${blocking} 项可逆回退未完成，不能发布修正版`);
  if (db.prepare("SELECT 1 FROM batches WHERE source_batch = ?").get(c.batch_id)) {
    throw new ApiError(409, '该批次已有修正版');
  }
  const newBatchId = String(input.new_batch_id ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(newBatchId)) throw new ApiError(400, 'new_batch_id 非法');
  if (db.prepare('SELECT 1 FROM batches WHERE id = ?').get(newBatchId)) throw new ApiError(409, '新批次号已存在');
  const normalized = normalizeRows(input.rows);
  if (!normalized.length) throw new ApiError(400, '修正版至少需要一行数据');

  return tx(db, () => {
    const at = nowIso();
    db.prepare(`INSERT INTO batches(id, label, origin, released_at, state, kind, source_batch, case_id, note)
                VALUES(?, ?, 'quality-correction', ?, 'active', 'corrected', ?, ?, ?)`)
      .run(newBatchId, String(input.label ?? `${newBatchId} 修正版`), at, c.batch_id, caseId,
        String(input.note ?? '').slice(0, 1000));
    insertRows(db, newBatchId, normalized);
    db.prepare("UPDATE batches SET state = 'superseded', version = version + 1 WHERE id = ? AND state != 'superseded'")
      .run(c.batch_id);
    const correctionId = uid('cor');
    db.prepare(`INSERT INTO corrections(id, case_id, source_batch, new_batch_id, state, created_at, published_at, note)
                VALUES(?, ?, ?, ?, 'published', ?, ?, ?)`)
      .run(correctionId, caseId, c.batch_id, newBatchId, at, at, String(input.note ?? '').slice(0, 1000));
    addCaseEvent(db, caseId, 'correction_published', `修正批次 ${newBatchId} 已发布，等待回补与消费核对`);

    // Replay reversible contributions for the union of previously affected
    // regions and regions present in the correction.
    const oldRegions = db.prepare(`
      SELECT DISTINCT region FROM consumptions
      WHERE batch_id = ? AND consumer = 'region-summary' AND reversible = 1
    `).all(c.batch_id).map((r) => r.region);
    const regions = [...new Set([...oldRegions, ...normalized.map((r) => r.region)])].sort();
    for (const region of regions) {
      const newRows = normalized.filter((r) => r.region === region);
      insertWork(db, {
        caseId, target: 'region-summary', targetRef: region,
        method: 'replay_corrected', reversible: 1, state: 'pending',
        idempotencyKey: `replay:${correctionId}:region-summary:${region}`,
        affectedRows: newRows.length,
        affectedAmount: round2(newRows.reduce((s, r) => s + r.amount, 0)),
      });
    }

    // One rebuild notice per previously exported artifact. Target ref is the
    // notice id, not the artifact, so producing the replacement does not
    // silently settle the loss.
    const artifacts = db.prepare(`
      SELECT DISTINCT a.id, a.path FROM artifacts a
      JOIN consumptions c ON c.artifact_id = a.id
      WHERE c.batch_id = ? AND c.reversible = 0
    `).all(c.batch_id);
    for (const art of artifacts) {
      insertWork(db, {
        caseId, target: 'workbook-export', targetRef: `rebuild:${art.id}`,
        method: 'rebuild_notice', reversible: 0, state: 'pending',
        idempotencyKey: `rebuild2:${correctionId}:${art.id}`,
        affectedRows: normalized.length,
        affectedAmount: round2(normalized.reduce((s, r) => s + r.amount, 0)),
      });
    }
    refreshCaseStatus(db, caseId);
    return {
      correction: db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId),
      batch: getBatch(db, newBatchId),
      replay_regions: regions,
    };
  });
}

/**
 * Replay corrected rows into the reversible aggregate for one region.
 * Idempotent via summary_ledger and the work item state.
 */
export function executeReplay(db, workId) {
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workId);
  if (!w) throw new ApiError(404, '工作项不存在');
  if (w.method !== 'replay_corrected') throw new ApiError(400, '只有重放工作项可以执行此操作');
  if (w.state === 'done') return { ok: true, already: true };
  if (w.state !== 'pending') throw new ApiError(409, `工作项状态为 ${w.state}`);
  const cor = db.prepare("SELECT * FROM corrections WHERE case_id = ? AND state IN ('published','failed')").get(w.case_id);
  if (!cor) throw new ApiError(409, '修正记录不存在或已核对完成');
  return tx(db, () => {
    const ledger = db.prepare('SELECT 1 FROM summary_ledger WHERE work_item_id = ? AND region = ?').get(w.id, w.target_ref);
    if (ledger) {
      settleWork(db, w.id, 'done', '重放已入账（幂等重放），未重复回补');
      refreshCaseStatus(db, w.case_id);
      return { ok: true, already: true };
    }
    const rows = db.prepare('SELECT * FROM batch_rows WHERE batch_id = ? AND region = ?').all(cor.new_batch_id, w.target_ref);
    let amount = 0;
    let qty = 0;
    for (const r of rows) {
      amount += r.amount;
      qty += r.qty;
      db.prepare(`
        INSERT INTO consumptions(id, consumer, consumer_kind, case_id, batch_id, row_id, region, amount, qty, reversible, state)
        VALUES(?, 'region-summary', 'aggregate', ?, ?, ?, ?, ?, ?, 1, 'applied')
      `).run(uid('cons'), w.case_id, cor.new_batch_id, r.row_id, r.region, r.amount, r.qty);
    }
    db.prepare('INSERT INTO summary_ledger(work_item_id, region, amount_delta, qty_delta, kind, at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(w.id, w.target_ref, round2(amount), qty, 'replay_corrected', nowIso());
    recomputeRegion(db, w.target_ref);
    settleWork(db, w.id, 'done', rows.length
      ? `已重放修正版 ${rows.length} 行，回补金额 ${round2(amount)}`
      : '修正版中该区域无行，无需回补');
    refreshCaseStatus(db, w.case_id);
    return { ok: true, replayed: rows.length, amount: round2(amount) };
  });
}

/* ═══════════════════════════ correction checks ═════════════════════════ */

/** Verify consumer state against the published correction. */
export function verifyCorrection(db, correctionId) {
  const cor = db.prepare('SELECT * FROM corrections WHERE id = ?').get(correctionId);
  if (!cor) throw new ApiError(404, '修正记录不存在');
  if (cor.state === 'verified') {
    return {
      correction: cor, already: true,
      checks: db.prepare('SELECT * FROM correction_checks WHERE correction_id = ? ORDER BY checked_at, id').all(cor.id),
    };
  }
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(cor.case_id);
  const source = getBatch(db, cor.source_batch);
  const corrected = getBatch(db, cor.new_batch_id);
  const at = nowIso();

  return tx(db, () => {
    const checks = [];
    const push = (name, scope, expected, actual, passed) => {
      const id = uid('chk');
      db.prepare(`INSERT INTO correction_checks(id, correction_id, check_name, scope, expected, actual, passed, checked_at)
                  VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, cor.id, name, scope, String(expected), String(actual), passed ? 1 : 0, at);
      checks.push({ id, correction_id: cor.id, check_name: name, scope, expected: String(expected), actual: String(actual), passed: passed ? 1 : 0, checked_at: at });
      return passed;
    };

    // 1. The reported field is actually different somewhere.
    const sourceSum = round2(source.rows.reduce((s, r) => s + r.amount, 0));
    const correctedSum = round2(corrected.rows.reduce((s, r) => s + r.amount, 0));
    const changed = source.rows.filter((s) => {
      const n = corrected.rows.find((r) => r.row_id === s.row_id);
      return !n || String(n[c.bad_field]) !== String(s[c.bad_field]) || n.region !== s.region;
    }).length;
    push('correction_changes_field', 'batch', '至少一行字段发生变化',
      `${changed} 行变化；源批次合计 ${sourceSum} → 修正版合计 ${correctedSum}`, changed > 0);

    // 2. No silent row drops.
    const missing = source.rows.filter((s) => !corrected.rows.some((r) => r.row_id === s.row_id));
    push('no_rows_dropped', 'batch', '0 行缺失', `${missing.length} 行缺失`, missing.length === 0);

    // 3. Reversible undo finished: no applied contribution from the bad batch.
    const badApplied = db.prepare(`
      SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM consumptions
      WHERE batch_id = ? AND consumer = 'region-summary' AND reversible = 1 AND state = 'applied'
    `).get(cor.source_batch);
    push('source_batch_fully_unwound', 'region-summary', '0 行仍生效',
      `${badApplied.n} 行仍生效（金额 ${round2(badApplied.s)}）`, badApplied.n === 0);

    // 4. Corrected contribution equals the corrected rows per region.
    for (const region of [...new Set(corrected.rows.map((r) => r.region))].sort()) {
      const expected = round2(corrected.rows.filter((r) => r.region === region).reduce((s, r) => s + r.amount, 0));
      const actual = round2(db.prepare(`
        SELECT COALESCE(SUM(amount),0) s FROM consumptions
        WHERE batch_id = ? AND consumer = 'region-summary' AND reversible = 1 AND state = 'applied' AND region = ?
      `).get(cor.new_batch_id, region).s);
      push('corrected_contribution_applied', `region:${region}`, expected, actual,
        Math.abs(expected - actual) < 0.01);
    }

    // 5. No region total is negative.
    const negative = db.prepare('SELECT region FROM consumer_summaries WHERE amount_sum < 0 OR qty_sum < 0').all();
    push('no_negative_totals', 'region-summary', '0 个区域为负',
      negative.length ? negative.map((r) => r.region).join(',') : '0 个区域为负', negative.length === 0);

    // 6. Old exports visible as loss, not silently rewritten.
    const oldArtifacts = db.prepare(`
      SELECT DISTINCT a.* FROM artifacts a JOIN consumptions c ON c.artifact_id = a.id
      WHERE c.batch_id = ? AND c.reversible = 0
    `).all(cor.source_batch);
    const lossAcked = db.prepare(`
      SELECT COUNT(*) n FROM acks a JOIN work_items w ON w.id = a.work_item_id
      WHERE w.case_id = ? AND a.outcome = 'loss_confirmed'
    `).get(c.id).n;
    const oldHasCurrent = oldArtifacts.some((a) => a.state === 'current');
    push('old_export_invalidated', 'workbook-export',
      '旧导出不再标记为 current（保留在案，未篡改）',
      `${oldArtifacts.length} 个旧导出，${lossAcked} 个确认丢失，旧导出状态 ${oldArtifacts.map((a) => a.state).join(',') || '无'}`,
      oldArtifacts.length === 0 || !oldHasCurrent);

    // 7. History intact: file content hash still matches the recorded hash.
    const tampered = oldArtifacts.filter((a) => !artifactHashMatches(a));
    push('export_history_intact', 'workbook-export', '旧导出文件哈希与记录一致',
      tampered.length ? `${tampered.map((a) => a.path).join(',')} 哈希不一致` : '全部一致', tampered.length === 0);

    // 8. A corrected export exists as a NEW artifact.
    const replacement = db.prepare("SELECT * FROM artifacts WHERE correction_id = ? AND state = 'current'").get(cor.id);
    push('replacement_export_exists', 'workbook-export', '存在修正版导出（新文件）',
      replacement ? `${replacement.path}（${replacement.state}）` : '缺失', Boolean(replacement));

    // 9. Every replay work item settled.
    const replayPending = db.prepare(`
      SELECT COUNT(*) n FROM work_items WHERE case_id = ? AND method = 'replay_corrected' AND state != 'done'
    `).get(c.id).n;
    push('replay_settled', 'work', '0 项待重放', `${replayPending} 项待重放`, replayPending === 0);

    const allPassed = checks.every((x) => x.passed === 1);
    db.prepare('UPDATE corrections SET state = ?, verified_at = ? WHERE id = ?')
      .run(allPassed ? 'verified' : 'failed', at, cor.id);

    // A verified replacement export settles the acknowledged losses: the loss
    // stays on record (artifact invalidated, ack kept) but the impact is no
    // longer "unhandled". Without a verified replacement it stays open.
    if (allPassed && replacement) {
      const losses = db.prepare(`
        SELECT * FROM work_items WHERE case_id = ? AND state = 'acknowledged_loss'
      `).all(c.id);
      for (const w of losses) {
        settleWork(db, w.id, 'superseded',
          `修正版导出 ${replacement.path} 已核对通过，原导出影响关闭（历史仍保留）`);
      }
    }

    refreshCaseStatus(db, c.id);
    const progress = caseProgress(db, c.id);
    if (allPassed && progress.pending === 0) {
      addCaseEvent(db, c.id, 'verified', '修正版消费核对通过，所有影响已核销，处置单关闭');
    } else if (allPassed) {
      addCaseEvent(db, c.id, 'verified',
        `修正版消费核对通过，但仍有 ${progress.pending} 项影响未处理（不可逆导出需修正版导出核对）`);
    } else {
      addCaseEvent(db, c.id, 'verify_failed',
        `修正版核对未通过：${checks.filter((x) => !x.passed).map((x) => x.check_name).join('、')}`);
    }
    return {
      correction: db.prepare('SELECT * FROM corrections WHERE id = ?').get(cor.id),
      checks, all_passed: allPassed,
      unhandled: db.prepare(`
        SELECT * FROM work_items WHERE case_id = ? AND state IN ('pending','acknowledged_loss','failed')
        ORDER BY target, target_ref
      `).all(c.id),
    };
  });
}

export function artifactHashMatches(artifact) {
  try {
    const content = readFileSync(join(ROOT, artifact.path), 'utf8');
    return sha256(content) === artifact.content_hash;
  } catch {
    return false;
  }
}

/* ═════════════════════════════ overview ════════════════════════════════ */

export function overview(db) {
  const workByState = db.prepare(`
    SELECT state, COUNT(*) n, COALESCE(SUM(affected_rows),0) rows, COALESCE(SUM(affected_amount),0) amount
    FROM work_items GROUP BY state ORDER BY state
  `).all();
  const workByTarget = db.prepare(`
    SELECT target, reversible, state, COUNT(*) n, COALESCE(SUM(affected_rows),0) rows,
      COALESCE(SUM(affected_amount),0) amount
    FROM work_items GROUP BY target, reversible, state ORDER BY target, state
  `).all();
  return {
    open_cases: db.prepare("SELECT COUNT(*) n FROM cases WHERE status != 'resolved'").get().n,
    partial_cases: db.prepare("SELECT COUNT(*) n FROM cases WHERE status = 'partially_resolved'").get().n,
    unhandled_impacts: db.prepare("SELECT COUNT(*) n FROM work_items WHERE state IN ('pending','acknowledged_loss','failed')").get().n,
    irreversible_open: db.prepare("SELECT COUNT(*) n FROM work_items WHERE reversible = 0 AND state IN ('pending','acknowledged_loss','failed')").get().n,
    acknowledged_losses: db.prepare("SELECT COUNT(*) n FROM work_items WHERE state = 'acknowledged_loss'").get().n,
    work_by_state: workByState.map((r) => ({ ...r, amount: round2(r.amount) })),
    work_by_target: workByTarget.map((r) => ({ ...r, amount: round2(r.amount) })),
    summaries: listSummaries(db),
    recent_artifacts: listArtifacts(db).slice(0, 8),
    totals: {
      batches: db.prepare('SELECT COUNT(*) n FROM batches').get().n,
      active_batches: db.prepare("SELECT COUNT(*) n FROM batches WHERE state = 'active'").get().n,
      invalidated_batches: db.prepare("SELECT COUNT(*) n FROM batches WHERE state = 'invalidated'").get().n,
      superseded_batches: db.prepare("SELECT COUNT(*) n FROM batches WHERE state = 'superseded'").get().n,
      cases: db.prepare('SELECT COUNT(*) n FROM cases').get().n,
      artifacts: db.prepare('SELECT COUNT(*) n FROM artifacts').get().n,
    },
  };
}

export function recordSchemaVersion(db, v) {
  setMeta(db, 'schema_version', v);
}

export function schemaVersion(db) {
  return getMeta(db, 'schema_version') ?? null;
}
