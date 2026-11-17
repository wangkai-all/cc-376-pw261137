// SQLite access. Uses Node's built-in node:sqlite (Node >= 22.5), so the
// project has no third-party dependencies. See README for the runtime flag
// required by some Node 22.x builds.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/**
 * Open (and migrate) the operational database.
 * @param {string} [file] path or ':memory:'
 */
export function openDb(file = join(ROOT, 'data', 'revocation.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    /* ── source batches ─────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS batches (
      id            TEXT PRIMARY KEY,
      label         TEXT NOT NULL DEFAULT '',
      origin        TEXT NOT NULL,
      released_at   TEXT NOT NULL,
      state         TEXT NOT NULL,             -- active | invalidated | superseded
      kind          TEXT NOT NULL DEFAULT 'normal', -- normal | corrected
      source_batch  TEXT,
      case_id       TEXT,
      note          TEXT NOT NULL DEFAULT '',
      version       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS batch_rows (
      batch_id      TEXT NOT NULL REFERENCES batches(id),
      row_id        TEXT NOT NULL,
      region        TEXT NOT NULL,
      qty           INTEGER NOT NULL,
      unit_price    REAL NOT NULL,
      amount        REAL NOT NULL,             -- value as published (can be wrong)
      PRIMARY KEY (batch_id, row_id)
    );

    /* ── data catalog ───────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS catalog_assets (
      id            TEXT PRIMARY KEY,          -- asset:<batch_id>:<row_id>
      batch_id      TEXT NOT NULL REFERENCES batches(id),
      row_id        TEXT NOT NULL,
      region        TEXT NOT NULL,
      state         TEXT NOT NULL,             -- current | flagged | withdrawn
      version       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS catalog_events (
      seq           INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id      TEXT NOT NULL,
      kind          TEXT NOT NULL,             -- backward_contribution | corrected
      reason        TEXT NOT NULL,
      at            TEXT NOT NULL
    );

    /* ── downstream consumptions ────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS consumptions (
      id             TEXT PRIMARY KEY,
      consumer       TEXT NOT NULL,            -- region-summary | workbook-export
      consumer_kind  TEXT NOT NULL,            -- aggregate | artifact
      case_id        TEXT,
      batch_id       TEXT NOT NULL REFERENCES batches(id),
      row_id         TEXT NOT NULL,
      region         TEXT NOT NULL,
      amount         REAL NOT NULL,
      qty            INTEGER NOT NULL,
      reversible     INTEGER NOT NULL,
      state          TEXT NOT NULL,            -- applied | pending | unwound | frozen
      artifact_id    TEXT,
      version        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_cons_batch ON consumptions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_cons_case ON consumptions(case_id);
    CREATE INDEX IF NOT EXISTS idx_cons_artifact ON consumptions(artifact_id);

    CREATE TABLE IF NOT EXISTS consumer_summaries (
      region         TEXT PRIMARY KEY,
      amount_sum     REAL NOT NULL DEFAULT 0,
      qty_sum        INTEGER NOT NULL DEFAULT 0,
      contributions  INTEGER NOT NULL DEFAULT 0
    );

    /* Exactly-once guard for every movement of the reversible aggregate. */
    CREATE TABLE IF NOT EXISTS summary_ledger (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id   TEXT NOT NULL,
      region         TEXT NOT NULL,
      amount_delta   REAL NOT NULL,
      qty_delta      INTEGER NOT NULL,
      kind           TEXT NOT NULL,            -- unwind | replay_corrected
      at             TEXT NOT NULL,
      UNIQUE(work_item_id, region)
    );

    /* ── immutable export artifacts ─────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS artifacts (
      id             TEXT PRIMARY KEY,
      path           TEXT NOT NULL,
      produced_at    TEXT NOT NULL,
      produced_by    TEXT NOT NULL,            -- producer | consumer
      content_hash   TEXT NOT NULL,
      row_count      INTEGER NOT NULL,
      state          TEXT NOT NULL,            -- current | superseded | invalidated
      correction_id  TEXT,
      note           TEXT NOT NULL DEFAULT ''
    );

    /* ── revocation cases ───────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS cases (
      id             TEXT PRIMARY KEY,
      batch_id       TEXT NOT NULL REFERENCES batches(id),
      reason         TEXT NOT NULL,
      bad_field      TEXT NOT NULL,
      status         TEXT NOT NULL,            -- propagating | partially_resolved | resolved
      opened_at      TEXT NOT NULL,
      closed_at      TEXT,
      created_by     TEXT NOT NULL DEFAULT 'quality-operator'
    );

    CREATE TABLE IF NOT EXISTS case_events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id        TEXT NOT NULL,
      at             TEXT NOT NULL,
      kind           TEXT NOT NULL,
      detail         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id              TEXT PRIMARY KEY,
      case_id         TEXT NOT NULL REFERENCES cases(id),
      target          TEXT NOT NULL,           -- catalog | region-summary | workbook-export
      target_ref      TEXT NOT NULL,
      method          TEXT NOT NULL,           -- backward_contribution | rebuild_notice | replay_corrected
      reversible      INTEGER NOT NULL,
      state           TEXT NOT NULL,           -- pending | done | acknowledged_loss | failed
      idempotency_key TEXT NOT NULL UNIQUE,
      affected_rows   INTEGER NOT NULL DEFAULT 0,
      affected_amount REAL NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_case ON work_items(case_id);

    CREATE TABLE IF NOT EXISTS work_events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id   TEXT NOT NULL,
      at             TEXT NOT NULL,
      kind           TEXT NOT NULL,
      detail         TEXT NOT NULL
    );

    /* Consumer acknowledgements: the primary idempotency boundary. */
    CREATE TABLE IF NOT EXISTS acks (
      key            TEXT PRIMARY KEY,
      work_item_id   TEXT NOT NULL,
      consumer       TEXT NOT NULL,
      outcome        TEXT NOT NULL,
      payload        TEXT NOT NULL,
      received_at    TEXT NOT NULL
    );

    /* ── corrected republication ────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS corrections (
      id             TEXT PRIMARY KEY,
      case_id        TEXT NOT NULL REFERENCES cases(id),
      source_batch   TEXT NOT NULL REFERENCES batches(id),
      new_batch_id   TEXT NOT NULL REFERENCES batches(id),
      state          TEXT NOT NULL,            -- published | verified | failed
      created_at     TEXT NOT NULL,
      published_at   TEXT,
      verified_at    TEXT,
      note           TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS correction_checks (
      id             TEXT PRIMARY KEY,
      correction_id  TEXT NOT NULL REFERENCES corrections(id),
      check_name     TEXT NOT NULL,
      scope          TEXT NOT NULL,
      expected       TEXT NOT NULL,
      actual         TEXT NOT NULL,
      passed         INTEGER NOT NULL,
      checked_at     TEXT NOT NULL
    );
  `);
}

/* ── transaction helper ─────────────────────────────────────────────── */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function bumpMeta(db, key, fallback = 0) {
  const next = Number(getMeta(db, key) ?? fallback) + 1;
  setMeta(db, key, next);
  return next;
}
