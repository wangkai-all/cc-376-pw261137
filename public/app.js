// 撤销传播处置台前端。无第三方依赖，原生 DOM 渲染。
// 所有来自 API 的文本一律用 textContent 插入，避免 HTML 注入。

const state = {
  view: 'overview',
  overview: null,
  cases: [],
  caseDetail: null,
  selectedCase: null,
  batches: [],
  artifacts: [],
  consumerCounts: [],
  caseUnhandled: new Map(),
  busy: false,
};

/* ─────────────── tiny DOM helpers ─────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only literal icon strings in this file
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const fmtMoney = (n) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const fmtCompact = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return fmtMoney(v);
};
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* status vocabulary → icon + label (never color alone) */
const ICONS = {
  good: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v4M8 11.4v.2"/></svg>',
  bad: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.2"/></svg>',
};
function chip(tone, label, extraClass = '') {
  return el('span', { class: `chip ${tone} ${extraClass}` },
    el('span', { class: 'ico', html: ICONS[tone] ?? ICONS.info }), label);
}

const CASE_STATUS = {
  propagating: ['warn', '传播中'],
  partially_resolved: ['bad', '部分处理'],
  resolved: ['good', '已关闭'],
};
const WORK_STATE = {
  pending: ['info', '待处理'],
  done: ['good', '已处理'],
  acknowledged_loss: ['bad', '确认丢失'],
  superseded: ['good', '已由修正版替代'],
  failed: ['bad', '失败/卡住'],
};
const BATCH_STATE = {
  active: ['good', '有效'],
  invalidated: ['bad', '已撤销'],
  superseded: ['info', '已被修正版替代'],
};
const ARTIFACT_STATE = {
  current: ['good', '当前有效'],
  invalidated: ['bad', '已失效（保留在案）'],
  superseded: ['info', '已被替代'],
};
const UNHANDLED_STATES = ['pending', 'acknowledged_loss', 'failed'];
const CHECK_LABELS = {
  correction_changes_field: '修正版确实修改了字段',
  no_rows_dropped: '修正版未丢失数据行',
  source_batch_fully_unwound: '源批次贡献已全部撤回',
  corrected_contribution_applied: '修正版贡献已入账',
  no_negative_totals: '汇总无负数',
  old_export_invalidated: '旧导出已失效',
  export_history_intact: '导出历史未被篡改',
  replacement_export_exists: '存在修正版导出',
  replay_settled: '重放工作项已结清',
};

/* ─────────────── api ─────────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 6000 : 3200);
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  $('#main').classList.add('loading');
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    state.busy = false;
    $('#main').classList.remove('loading');
  }
}

/* ─────────────── data loading ─────────────── */
async function fetchCore() {
  const [overview, cases, batches, artifacts, consumptions] = await Promise.all([
    api('GET', '/api/overview'),
    api('GET', '/api/cases'),
    api('GET', '/api/batches'),
    api('GET', '/api/artifacts'),
    api('GET', '/api/consumptions'),
  ]);
  state.overview = overview;
  state.cases = cases.cases;
  state.batches = batches.batches;
  state.artifacts = artifacts.artifacts;
  state.consumerCounts = consumptions.counts;
}

async function loadAll() {
  await fetchCore();
  if (state.selectedCase) {
    try {
      state.caseDetail = await api('GET', `/api/cases/${state.selectedCase}`);
    } catch {
      state.caseDetail = null;
      state.selectedCase = null;
    }
  }
  // Pull work items for every open case so the overview's unhandled list is
  // complete (an acknowledged loss is invisible in the progress counters alone).
  state.caseUnhandled = new Map();
  await Promise.all(state.cases
    .filter((c) => c.progress.pending > 0)
    .map(async (c) => {
      try {
        const d = await api('GET', `/api/cases/${c.id}`);
        state.caseUnhandled.set(c.id, d.work_items);
      } catch { /* case changed under us; the next refresh reconciles */ }
    }));
  render();
}

/* ─────────────── render: overview ─────────────── */
function renderOverview() {
  const o = state.overview;
  if (!o) return;

  const kpis = $('#kpis');
  kpis.replaceChildren(
    stat('未关闭处置单', o.open_cases, `${o.partial_cases} 个部分处理`, o.partial_cases ? 'bad' : ''),
    stat('未处理影响', o.unhandled_impacts, `可逆 ${o.unhandled_impacts - o.irreversible_open} · 不可逆 ${o.irreversible_open}`, o.unhandled_impacts ? 'bad' : 'ok'),
    stat('确认丢失的导出', o.acknowledged_losses, o.acknowledged_losses ? '需修正版导出核对后才关闭' : '无', o.acknowledged_losses ? 'bad' : 'ok'),
    stat('批次', o.totals.batches, `有效 ${o.totals.active_batches} · 撤销 ${o.totals.invalidated_batches}`, ''),
  );

  // Impact bars: per target, handled vs open
  const byTarget = new Map();
  for (const r of o.work_by_target) {
    const t = byTarget.get(r.target) ?? { target: r.target, reversible: r.reversible === 1, done: 0, open: 0 };
    if (r.state === 'done' || r.state === 'superseded') t.done += r.n;
    else t.open += r.n;
    byTarget.set(r.target, t);
  }
  const targets = [...byTarget.values()].sort((a, b) => (b.done + b.open) - (a.done + a.open));
  const maxCount = Math.max(1, ...targets.map((t) => t.done + t.open));
  const bars = $('#impact-bars');
  bars.replaceChildren();
  if (!targets.length) bars.append(el('p', { class: 'empty', text: '还没有撤销工作项' }));
  for (const t of targets) {
    const total = t.done + t.open;
    const label = t.target === 'catalog' ? '数据目录'
      : t.target === 'region-summary' ? '区域汇总' : '工作簿导出';
    const track = el('div', { class: 'track', role: 'group', 'aria-label': `${label}：已处理 ${t.done}，未处理 ${t.open}` });
    const sole = t.done === 0 || t.open === 0 ? ' only' : '';
    if (t.done) {
      track.append(el('div', {
        class: `seg done${sole}`, style: `width:${(t.done / maxCount) * 100}%`,
        title: `${label} · 已处理 ${t.done} 项`, tabindex: '0',
      }));
    }
    if (t.open) {
      track.append(el('div', {
        class: `seg open${sole}`, style: `width:${(t.open / maxCount) * 100}%`,
        title: `${label} · 未处理 ${t.open} 项`, tabindex: '0',
      }));
    }
    bars.append(el('div', { class: 'bar-row' },
      el('span', { class: 'name' },
        el('span', { text: label }),
        t.reversible ? chip('info', '可逆', 'rev') : chip('warn', '不可逆', 'irrev'),
      ),
      track,
      el('span', { class: 'val' }, String(total), el('small', { text: ' 项' })),
    ));
  }
  if (targets.length) {
    bars.append(el('div', { class: 'legend' },
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: 'background:var(--series-1)' }), '已处理（done / superseded）'),
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: 'background:var(--series-2)' }), '未处理（含确认丢失、失败）'),
    ));
  }

  const itbody = $('#impact-table tbody');
  itbody.replaceChildren();
  for (const t of targets) {
    itbody.append(el('tr', {},
      el('td', { text: t.target === 'catalog' ? '数据目录' : t.target === 'region-summary' ? '区域汇总' : '工作簿导出' }),
      el('td', {}, t.reversible ? chip('info', '可逆') : chip('warn', '不可逆')),
      el('td', { class: 'num', text: t.done + t.open }),
      el('td', { class: 'num', text: t.done }),
      el('td', { class: 'num', text: t.open }),
    ));
  }

  // Region summary bars (single series → slot 1, no legend; title names it)
  const summaries = [...o.summaries].sort((a, b) => b.amount_sum - a.amount_sum);
  const maxRegion = Math.max(1, ...summaries.map((s) => s.amount_sum));
  const rc = $('#region-chart');
  rc.replaceChildren();
  if (!summaries.length) rc.append(el('p', { class: 'empty', text: '尚无汇总' }));
  for (const s of summaries) {
    rc.append(el('div', { class: 'sbar' },
      el('span', { class: 'name', text: s.region }),
      el('div', { class: 'track' },
        el('div', {
          class: 'fill',
          style: `width:${Math.max(0.5, (s.amount_sum / maxRegion) * 100)}%`,
          tabindex: '0',
          title: `${s.region}：金额 ${fmtMoney(s.amount_sum)}，数量 ${s.qty_sum}，贡献 ${s.contributions} 行`,
          'aria-label': `${s.region} 金额合计 ${fmtMoney(s.amount_sum)}`,
        })),
      el('span', { class: 'v', text: fmtCompact(s.amount_sum) }),
    ));
  }
  const rt = $('#region-table tbody');
  rt.replaceChildren();
  for (const s of summaries) {
    rt.append(el('tr', {},
      el('td', { text: s.region }),
      el('td', { class: 'num', text: fmtMoney(s.amount_sum) }),
      el('td', { class: 'num', text: s.qty_sum }),
      el('td', { class: 'num', text: s.contributions }),
    ));
  }

  // Open cases
  const list = $('#open-cases');
  list.replaceChildren();
  const open = state.cases.filter((c) => c.status !== 'resolved');
  if (!open.length) list.append(el('p', { class: 'empty', text: '当前没有未关闭的处置单' }));
  for (const c of open) list.append(caseRow(c));

  // Unhandled detail, straight from work items (not inferred from status)
  const unhandledHost = $('#unhandled-list');
  unhandledHost.replaceChildren();
  let any = false;
  for (const c of state.cases) {
    const detail = state.caseUnhandled.get(c.id);
    if (!detail) continue;
    const items = detail.filter((w) => UNHANDLED_STATES.includes(w.state));
    if (!items.length) continue;
    any = true;
    unhandledHost.append(el('h3', { text: `${c.batch_id} · 处置单 ${c.id}` }));
    const ul = el('ul');
    for (const w of items) {
      const [tone, label] = WORK_STATE[w.state] ?? ['info', w.state];
      const name = w.target === 'catalog' ? '数据目录'
        : w.target === 'region-summary' ? `区域汇总 · ${w.target_ref}`
          : `工作簿导出 · ${w.target_ref}`;
      ul.append(el('li', {},
        `${name} `, chip(tone, label),
        ` 影响 ${w.affected_rows} 行 / ${fmtMoney(w.affected_amount)}`,
        w.state === 'acknowledged_loss' ? ' — 不可逆导出，修正版导出核对前保持未处理' : '',
        w.state === 'failed' ? ` — ${w.last_error || '已标记失败'}` : '',
      ));
    }
    unhandledHost.append(ul);
  }
  if (!any) unhandledHost.append(el('p', { class: 'empty', text: '所有影响均已处理。' }));
}

function stat(label, value, delta, tone = '') {
  return el('div', { class: 'stat' },
    el('span', { class: 'label', text: label }),
    el('span', { class: 'value' }, String(value)),
    el('span', { class: `delta ${tone}`, text: delta }),
  );
}

function caseRow(c) {
  const batch = state.batches.find((b) => b.id === c.batch_id);
  const [tone, label] = CASE_STATUS[c.status] ?? ['info', c.status];
  const p = c.progress;
  const total = Math.max(1, p.total);
  const progress = el('div', { class: 'progress', 'aria-hidden': 'true' },
    el('span', { style: `width:${(p.settled / total) * 100}%;background:var(--series-1)` }),
    el('span', { style: `width:${(p.pending / total) * 100}%;background:var(--series-2)` }),
  );
  return el('div', { class: 'case-row' },
    el('div', { class: 'info' },
      el('div', { class: 'line' },
        el('h3', { text: batch?.label ?? c.batch_id }),
        chip(tone, label),
        c.progress.acknowledged_losses ? chip('bad', `不可逆丢失 ${c.progress.acknowledged_losses}`, 'loss') : null,
      ),
      el('div', { class: 'sub muted', text: `${c.batch_id} · 错误字段 ${c.bad_field} · 已处理 ${p.settled}/${p.total}` }),
      progress,
    ),
    el('div', {},
      el('button', {
        class: 'btn sm', type: 'button', text: '查看处置',
        onclick: () => { selectCase(c.id); setView('cases'); },
      })),
  );
}

/* ─────────────── render: cases ─────────────── */
function renderCases() {
  const rail = $('#case-rail');
  rail.replaceChildren();
  if (!state.cases.length) rail.append(el('p', { class: 'empty', text: '暂无处置单' }));
  for (const c of state.cases) {
    const [tone, label] = CASE_STATUS[c.status] ?? ['info', c.status];
    rail.append(el('li', {},
      el('button', {
        type: 'button', 'aria-current': String(c.id === state.selectedCase),
        onclick: () => selectCase(c.id),
      },
        el('span', { class: 't', text: c.batch_id }),
        el('span', { class: 's' }, chip(tone, label), ` 未处理 ${c.progress.pending}`),
      )));
  }
  renderCaseDetail();
}

function selectCase(id) {
  state.selectedCase = id;
  state.caseDetail = null;
  api('GET', `/api/cases/${id}`).then((d) => {
    state.caseDetail = d;
    state.caseUnhandled.set(d.id, d.work_items);
    renderCases();
    renderOverview();
  }).catch((e) => toast(e.message, true));
}

function renderCaseDetail() {
  const host = $('#case-detail');
  const c = state.caseDetail;
  if (!c) {
    host.replaceChildren(el('p', { class: 'empty', text: '选择左侧处置单查看影响传播与核对。' }));
    return;
  }
  const [tone, label] = CASE_STATUS[c.status] ?? ['info', c.status];
  const batch = c.batch;
  const work = c.work_items;
  const unhandled = work.filter((w) => UNHANDLED_STATES.includes(w.state));
  const reversibleOpen = work.filter((w) => w.reversible === 1 && w.state !== 'done');
  const undoOpen = reversibleOpen.filter((w) => w.method !== 'replay_corrected');
  const replayOpen = reversibleOpen.filter((w) => w.method === 'replay_corrected');
  const bulkLabel = undoOpen.length && replayOpen.length
    ? `执行反向贡献 ${undoOpen.length} 项 + 重放 ${replayOpen.length} 项`
    : undoOpen.length ? `执行全部反向贡献（${undoOpen.length}）`
      : `重放修正版（${replayOpen.length}）`;
  const correction = c.corrections[c.corrections.length - 1];

  const hero = el('article', { class: 'card case-hero' },
    el('div', { class: 'title-row' },
      el('h2', { text: batch?.label ?? c.batch_id }),
      chip(tone, label),
      c.progress.acknowledged_losses ? chip('bad', `不可逆丢失 ${c.progress.acknowledged_losses}`, 'loss') : null,
    ),
    el('div', { class: 'meta' },
      el('span', { text: `处置单 ${c.id}` }),
      el('span', { text: `批次 ${c.batch_id}（${batch?.origin ?? '—'}）` }),
      el('span', { text: `错误字段 ${c.bad_field}` }),
      el('span', { text: `打开于 ${fmtTime(c.opened_at)}` }),
    ),
    el('p', { class: 'muted', text: `原因：${c.reason}` }),
    el('div', { class: 'case-actions' },
      reversibleOpen.length
        ? el('button', {
          class: 'btn primary', type: 'button', text: bulkLabel,
          onclick: () => withBusy(() => runAllReversible(c, reversibleOpen)),
        })
        : null,
      reversibleOpen.length === 0 && !correction
        ? el('button', {
          class: 'btn primary', type: 'button', text: '发布修正版…',
          onclick: () => withBusy(() => openCorrectionDialog(c)),
        })
        : null,
      correction
        ? el('button', {
          class: 'btn', type: 'button',
          text: correction.state === 'verified' ? '重新运行消费核对' : '运行消费核对',
          onclick: () => withBusy(() => verifyCorrection(correction.id)),
        })
        : null,
    ),
  );

  const panelHost = el('div', {});

  if (unhandled.length) {
    const panel = el('div', { class: 'unhandled' },
      el('h3', {}, '未处理影响 ', chip('bad', `${unhandled.length} 项`)),
    );
    const ul = el('ul');
    for (const w of unhandled) {
      const [t2, l2] = WORK_STATE[w.state] ?? ['info', w.state];
      const name = w.target === 'catalog' ? '数据目录'
        : w.target === 'region-summary' ? `区域汇总 · ${w.target_ref}` : `工作簿导出 · ${w.target_ref}`;
      ul.append(el('li', {},
        `${name} — `, chip(t2, l2),
        `，影响 ${w.affected_rows} 行 / 金额 ${fmtMoney(w.affected_amount)}`,
        w.state === 'acknowledged_loss' ? '（不可逆，需修正版导出核对后才关闭）'
          : w.state === 'failed' ? `（${w.last_error || '已标记失败'}）` : '',
      ));
    }
    panel.append(ul);
    panelHost.append(panel);
  }

  const groups = new Map();
  for (const w of work) {
    const arr = groups.get(w.target) ?? [];
    arr.push(w);
    groups.set(w.target, arr);
  }
  const workCard = el('article', { class: 'card' },
    el('div', { class: 'section-title' },
      el('h2', { text: '影响传播工作项' }),
      el('span', { class: 'muted', text: '可逆：反向贡献；不可逆：通知重建' })),
    el('div', { class: 'work-group' }),
  );
  const wg = workCard.querySelector('.work-group');
  for (const [target, items] of [...groups.entries()].sort()) {
    const title = target === 'catalog' ? '数据目录' : target === 'region-summary' ? '区域汇总（可逆）' : '工作簿导出（不可逆）';
    wg.append(el('h3', { text: title, style: 'margin:8px 0 2px' }));
    for (const w of items) wg.append(workItemRow(c, w));
  }
  panelHost.append(workCard);

  const tl = el('article', { class: 'card' },
    el('h2', { text: '处置轨迹', style: 'margin-bottom:12px' }),
    el('ul', { class: 'timeline' }),
  );
  const tlu = tl.querySelector('.timeline');
  for (const ev of c.events) {
    tlu.append(el('li', {},
      el('time', { text: fmtTime(ev.at) }),
      el('span', { text: ev.detail }),
    ));
  }
  if (!c.events.length) tlu.append(el('li', { class: 'empty', text: '暂无事件' }));
  panelHost.append(tl);

  if (correction) panelHost.append(correctionCard(c, correction));

  host.replaceChildren(hero, panelHost);
}

function workItemRow(c, w) {
  const [tone, label] = WORK_STATE[w.state] ?? ['info', w.state];
  const isLoss = w.state === 'acknowledged_loss';
  const targetName = w.target === 'catalog' ? '数据目录'
    : w.target === 'region-summary' ? '区域汇总' : '工作簿导出';
  const actions = el('div', { class: 'actions' });
  if (w.state === 'pending' && w.reversible) {
    actions.append(el('button', {
      class: 'btn sm primary', type: 'button',
      text: w.method === 'replay_corrected' ? '重放修正版' : '执行反向贡献',
      onclick: () => withBusy(async () => {
        const res = w.method === 'replay_corrected'
          ? await api('POST', `/api/work/${w.id}/replay`)
          : await api('POST', `/api/work/${w.id}/execute`);
        await reloadCase(c.id);
        toast(res.already
          ? '该项此前已执行（幂等重放，未重复处理）'
          : w.method === 'replay_corrected'
            ? `已重放修正版 ${res.replayed ?? 0} 行`
            : '反向贡献已执行');
      }),
    }));
  }
  if (w.state === 'pending' && w.reversible === 0) {
    actions.append(el('button', {
      class: 'btn sm', type: 'button', text: '消费端确认丢失',
      onclick: () => withBusy(async () => {
        const note = window.prompt('说明该导出为何无法回收（会留在审计轨迹中）：', '已分发到业务方，无法回收');
        if (note === null) return;
        await api('POST', `/api/work/${w.id}/ack-loss`, {
          consumer: 'workbook-export', note, key: `loss:${w.id}`,
        });
        await reloadCase(c.id);
        toast('已记录确认丢失；该影响保持未处理，直到修正版导出核对通过');
      }),
    }));
  }
  if (w.state === 'pending') {
    actions.append(el('button', {
      class: 'btn sm', type: 'button', text: '标记失败',
      onclick: () => withBusy(async () => {
        const reason = window.prompt('标记失败原因（未处理影响会继续显示）：', '消费端离线，无法联系');
        if (reason === null) return;
        await api('POST', `/api/work/${w.id}/fail`, { reason });
        await reloadCase(c.id);
      }),
    }));
  }

  return el('div', { class: `work-item ${isLoss ? 'lossy' : ''} ${w.state === 'done' ? 'done' : ''}` },
    el('div', { class: 'wt' },
      el('div', { class: 'line' },
        el('strong', { text: targetName }),
        el('span', { class: 'mono muted', text: w.target_ref.startsWith('batch:') ? w.target_ref.slice(6) : w.target_ref }),
        chip(tone, label),
        w.reversible ? chip('info', '可逆', 'rev') : chip('warn', '不可逆', 'irrev'),
      ),
      el('div', { class: 'sub', text: `方法 ${w.method} · 影响 ${w.affected_rows} 行 · 金额 ${fmtMoney(w.affected_amount)}` }),
      el('details', { class: 'ev' },
        el('summary', { text: `轨迹（${w.events.length}）` }),
        el('ul', {}, ...w.events.map((e) => el('li', { text: `${fmtTime(e.at)} ${e.detail}` }))),
      ),
    ),
    actions,
  );
}

function correctionCard(c, corr) {
  const checks = corr.checks ?? [];
  const stateChip = corr.state === 'verified' ? chip('good', '核对通过')
    : corr.state === 'failed' ? chip('bad', '核对未通过') : chip('warn', '待核对');
  const card = el('article', { class: 'card' },
    el('div', { class: 'section-title' },
      el('h2', { text: `修正版 ${corr.new_batch_id}` }), stateChip),
    el('p', { class: 'muted', text: `源批次 ${corr.source_batch} → 修正版 ${corr.new_batch_id}，发布于 ${fmtTime(corr.published_at)}。修正版导出为新文件；旧导出保留在案并标记失效。` }),
    el('div', { class: 'table-wrap', style: 'margin-top:12px' }),
  );
  const wrap = card.querySelector('.table-wrap');
  if (!checks.length) {
    wrap.append(el('p', { class: 'empty', text: '尚未执行消费核对。' }));
    card.append(el('div', { class: 'form-actions' },
      el('button', {
        class: 'btn primary', type: 'button', text: '运行消费核对',
        onclick: () => withBusy(() => verifyCorrection(corr.id)),
      }),
    ));
    return card;
  }
  wrap.append(el('table', { class: 'data check-table' },
    el('caption', { class: 'sr-only', text: '修正版消费核对明细' }),
    el('thead', {}, el('tr', {},
      el('th', { text: '核对项' }), el('th', { text: '范围' }),
      el('th', { text: '期望' }), el('th', { text: '实际' }), el('th', { text: '结果' }))),
    el('tbody', {}, ...checks.map((k) => el('tr', {},
      el('td', {},
        el('div', { text: CHECK_LABELS[k.check_name] ?? k.check_name }),
        el('div', { class: 'muted mono', text: k.check_name }),
      ),
      el('td', { class: 'mono', text: k.scope }),
      el('td', { class: 'mono', text: k.expected }),
      el('td', { class: 'mono', text: k.actual }),
      el('td', { class: k.passed ? 'pass' : 'fail', text: k.passed ? '通过' : '未通过' }),
    ))),
  ));
  return card;
}

async function reloadCase(caseId) {
  const detail = await api('GET', `/api/cases/${caseId}`);
  await fetchCore();
  state.caseDetail = detail;
  state.caseUnhandled.set(detail.id, detail.work_items);
  render();
}

async function runAllReversible(c, items) {
  let undone = 0;
  let replayed = 0;
  for (const w of items) {
    if (w.method === 'replay_corrected') {
      await api('POST', `/api/work/${w.id}/replay`);
      replayed += 1;
    } else {
      await api('POST', `/api/work/${w.id}/execute`);
      undone += 1;
    }
  }
  await reloadCase(c.id);
  const parts = [];
  if (undone) parts.push(`反向贡献 ${undone} 项`);
  if (replayed) parts.push(`重放修正版 ${replayed} 项`);
  toast(`已执行：${parts.join('，')}`);
}

async function verifyCorrection(correctionId) {
  const res = await api('POST', `/api/corrections/${correctionId}/verify`);
  const c = state.caseDetail;
  if (c) {
    const detail = await api('GET', `/api/cases/${c.id}`);
    await fetchCore();
    state.caseDetail = detail;
    state.caseUnhandled.set(detail.id, detail.work_items);
  }
  render();
  toast(res.all_passed
    ? (res.unhandled.length ? `核对通过，但仍有 ${res.unhandled.length} 项影响未处理` : '核对通过，所有影响已核销')
    : `核对未通过：${res.checks.filter((x) => !x.passed).map((x) => x.check_name).join('、')}`, !res.all_passed);
}

async function openCorrectionDialog(c) {
  const source = await api('GET', `/api/batches/${c.batch_id}`);
  const rows = correctedRowsFrom(c, source.rows);
  const text = rows.map((r) => `${r.row_id},${r.region},${r.qty},${r.unit_price},${r.amount}`).join('\n');
  const dlg = $('#correction-dialog');
  dlg.querySelector('[name="case_id"]').value = c.id;
  dlg.querySelector('[name="new_batch_id"]').value = `${c.batch_id}F`;
  dlg.querySelector('[name="label"]').value = `${source.label}（修正版）`;
  dlg.querySelector('[name="rows"]').value = text;
  dlg.querySelector('[name="note"]').value = `按质量处置单 ${c.id} 修正 ${c.bad_field}`;
  dlg.showModal();
}

function correctedRowsFrom(c, rows) {
  // Starting point for the operator: the reported bad field recomputed from the
  // other columns. Everything remains editable before publishing.
  return rows.map((r) => {
    const next = { ...r };
    if (c.bad_field === 'amount') next.amount = Math.round(r.qty * r.unit_price * 100) / 100;
    if (c.bad_field === 'qty' && r.unit_price > 0) next.qty = Math.round(r.amount / r.unit_price);
    if (c.bad_field === 'unit_price' && r.qty > 0) next.unit_price = Math.round((r.amount / r.qty) * 100) / 100;
    return next;
  });
}

/* ─────────────── render: batches ─────────────── */
function renderBatches() {
  const tb = $('#batch-table tbody');
  tb.replaceChildren();
  for (const b of state.batches) {
    const [tone, label] = BATCH_STATE[b.state] ?? ['info', b.state];
    tb.append(el('tr', {},
      el('td', {}, el('div', { text: b.id }), el('div', { class: 'muted', text: b.label })),
      el('td', { text: b.origin }),
      el('td', {}, chip(tone, label), b.kind === 'corrected' ? chip('info', '修正版') : null),
      el('td', { class: 'num', text: b.row_count }),
      el('td', { class: 'num', text: fmtMoney(b.total_amount) }),
      el('td', {},
        el('button', {
          class: 'btn sm', type: 'button', text: '查看明细',
          onclick: () => withBusy(async () => {
            const full = await api('GET', `/api/batches/${b.id}`);
            showBatchDialog(full);
          }),
        })),
    ));
  }
}

function showBatchDialog(batch) {
  const dlg = $('#batch-dialog');
  dlg.querySelector('h2').textContent = `${batch.id} · ${batch.label}`;
  const bodyEl = dlg.querySelector('tbody');
  bodyEl.replaceChildren(...batch.rows.map((r) => el('tr', {},
    el('td', { class: 'mono', text: r.row_id }),
    el('td', { text: r.region }),
    el('td', { class: 'num', text: r.qty }),
    el('td', { class: 'num', text: fmtMoney(r.unit_price) }),
    el('td', { class: 'num', text: fmtMoney(r.amount) }),
  )));
  dlg.showModal();
}

/* ─────────────── render: consumers ─────────────── */
function renderConsumers() {
  const host = $('#consume-counts');
  host.replaceChildren();
  const table = el('table', { class: 'data' },
    el('thead', {}, el('tr', {},
      el('th', { text: '消费端' }), el('th', { text: '可逆性' }),
      el('th', { text: '消费状态' }), el('th', { class: 'num', text: '行数' }),
      el('th', { class: 'num', text: '金额' }))),
  );
  const tb = el('tbody');
  for (const r of state.consumerCounts) {
    const [tone, label] = WORK_STATE[r.state] ?? ['info', r.state];
    tb.append(el('tr', {},
      el('td', { text: r.consumer }),
      el('td', {}, r.reversible ? chip('info', '可逆汇总', 'rev') : chip('warn', '不可逆导出', 'irrev')),
      el('td', {}, chip(tone, label)),
      el('td', { class: 'num', text: r.n }),
      el('td', { class: 'num', text: fmtMoney(r.amount) }),
    ));
  }
  table.append(tb);
  host.append(table);

  const at = $('#artifact-table tbody');
  at.replaceChildren();
  for (const a of state.artifacts) {
    const [tone, label] = ARTIFACT_STATE[a.state] ?? ['info', a.state];
    at.append(el('tr', {},
      el('td', {}, el('div', { class: 'mono', text: a.path.split('/').pop() }), el('div', { class: 'muted', text: fmtTime(a.produced_at) })),
      el('td', {}, chip(tone, label)),
      el('td', { class: 'num', text: a.row_count }),
      el('td', { class: 'mono muted', text: a.content_hash.slice(0, 12) }),
      el('td', {}, el('a', { class: 'btn sm', href: `/api/artifacts/${a.id}/download`, text: '下载', download: '' })),
    ));
  }

  const dl = $('#artifact-dl');
  dl.replaceChildren();
  for (const a of state.artifacts) {
    const [tone, label] = ARTIFACT_STATE[a.state] ?? ['info', a.state];
    dl.append(el('div', { class: 'dl-row' },
      el('span', {}, el('span', { class: 'mono', text: a.path }), ' ', chip(tone, label),
        a.correction_id ? chip('info', '修正版') : null),
      el('a', { class: 'btn sm', href: `/api/artifacts/${a.id}/download`, download: '', text: '下载 CSV' }),
    ));
  }

  // Batch selector: only batches the server will actually accept. Revoked and
  // superseded batches are refused, and the reversible consumer must not see
  // corrected batches (their replay is owned by the disposal case).
  const sel = $('#consume-batch');
  const previous = sel.value;
  const consumer = $('#consume-consumer').value;
  const eligible = state.batches.filter((b) => b.state === 'active'
    && (consumer === 'region-summary' ? b.kind !== 'corrected' : true));
  sel.replaceChildren(...eligible.map((b) =>
    el('option', { value: b.id, text: `${b.id}（${b.state}${b.kind === 'corrected' ? ' · 修正版' : ''}）` })));
  const keep = eligible.some((b) => b.id === previous) ? previous
    : (eligible.find((b) => b.state === 'active') ?? eligible[0])?.id;
  if (keep) sel.value = keep;
  $('#consume-hint').textContent = consumer === 'region-summary'
    ? '可逆汇总只列出仍有效的普通批次；修正版数据的回补由处置单重放，不能直接消费。'
    : '不可逆导出只列出仍有效的批次；首次消费生成新文件，重复消费不会改写已有导出。';

  renderOpenCaseBatchSelect();
}

function renderOpenCaseBatchSelect() {
  const sel = $('#open-case-form [name="batch_id"]');
  const previous = sel.value;
  const eligible = state.batches.filter((b) => b.state === 'active' && b.kind === 'normal');
  sel.replaceChildren(...eligible.map((b) => el('option', { value: b.id, text: `${b.id} · ${b.label}` })));
  if (previous) sel.value = previous;
}

/* ─────────────── render dispatch ─────────────── */
function render() {
  renderOverview();
  renderCases();
  renderBatches();
  renderConsumers();
}

function setView(name) {
  state.view = name;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  for (const v of $$('.view')) v.classList.toggle('hidden', v.id !== `view-${name}`);
}

/* ─────────────── events ─────────────── */
function wire() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  $('#refresh-btn').addEventListener('click', () => withBusy(loadAll));

  const dlg = $('#open-case-dialog');
  $('#open-case-btn').addEventListener('click', () => {
    renderOpenCaseBatchSelect();
    if (!$('#open-case-form [name="batch_id"]').options.length) {
      toast('没有可撤销的有效批次', true);
      return;
    }
    dlg.showModal();
  });
  $('#cancel-open-case').addEventListener('click', () => dlg.close());
  $('#open-case-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('batch_id')) { toast('请选择批次', true); return; }
    dlg.close();
    withBusy(async () => {
      const res = await api('POST', '/api/cases', {
        batch_id: fd.get('batch_id'), bad_field: fd.get('bad_field'), reason: fd.get('reason'),
      });
      state.selectedCase = res.id;
      await loadAll();
      setView('cases');
      toast(`已打开处置单 ${res.id}；影响按真实消费记录生成`);
    });
  });

  $('#ingest-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rows = parseCsv(String(fd.get('rows') ?? ''));
    if (rows.error) { toast(rows.error, true); return; }
    withBusy(async () => {
      const res = await api('POST', '/api/ingest', {
        batch_id: fd.get('batch_id'), origin: fd.get('origin'), rows: rows.value,
      });
      await loadAll();
      $('#ingest-hint').textContent = `已导入 ${res.batch.id}（${res.batch.rows.length} 行）${res.duplicate ? '（幂等重复）' : ''}`;
      toast(`批次 ${res.batch.id} 已发布`);
    });
  });

  $('#consume-consumer').addEventListener('change', () => renderConsumers());
  $('#consume-btn').addEventListener('click', () => withBusy(async () => {
    const consumer = $('#consume-consumer').value;
    const batchId = $('#consume-batch').value;
    if (!batchId) { toast('请选择批次', true); return; }
    const res = await api('POST', `/api/consumers/${consumer}/consume`, { batch_id: batchId });
    await loadAll();
    if (res.already) toast(`${consumer} 已消费过 ${batchId}，未重复写入`);
    else if (res.artifact) toast(`${consumer} 生成新导出 ${res.artifact.path.split('/').pop()}（不可逆）`);
    else toast(`${consumer} 消费 ${batchId}：写入 ${res.applied} 行`);
  }));

  const cdlg = $('#correction-dialog');
  cdlg.querySelector('[name="cancel"]').addEventListener('click', () => cdlg.close());
  cdlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const rows = parseCsv(String(fd.get('rows') ?? ''));
    if (rows.error) { toast(rows.error, true); return; }
    const caseId = String(fd.get('case_id'));
    cdlg.close();
    withBusy(async () => {
      const res = await api('POST', '/api/corrections', {
        case_id: caseId,
        new_batch_id: fd.get('new_batch_id'),
        label: fd.get('label'),
        rows: rows.value,
        note: fd.get('note'),
      });
      await reloadCase(caseId);
      toast(`修正版 ${res.batch.id} 已发布：可逆项待重放，导出待消费端重新生成`);
    });
  });

  $('#batch-dialog .close').addEventListener('click', () => $('#batch-dialog').close());
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const rows = [];
  for (const [i, line] of lines.entries()) {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 4) return { error: `第 ${i + 1} 行需要至少 4 列：row_id,region,qty,unit_price[,amount]` };
    const [row_id, region, qty, unit_price, amount] = cells;
    if (!row_id || !region) return { error: `第 ${i + 1} 行 row_id / region 不能为空` };
    const row = { row_id, region, qty: Number(qty), unit_price: Number(unit_price) };
    if (!row_id || !region || !Number.isFinite(row.qty) || !Number.isFinite(row.unit_price)) {
      return { error: `第 ${i + 1} 行 qty / unit_price 必须是数字` };
    }
    if (amount !== undefined && amount !== '') {
      row.amount = Number(amount);
      if (!Number.isFinite(row.amount)) return { error: `第 ${i + 1} 行 amount 必须是数字` };
    }
    rows.push(row);
  }
  if (!rows.length) return { error: '至少需要一行数据' };
  return { value: rows };
}

/* ─────────────── boot ─────────────── */
wire();
withBusy(loadAll);
