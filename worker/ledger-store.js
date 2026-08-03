import {
  normalizeLedgerEvent,
  replayPortfolioLedger,
  validateLedgerEvent,
} from './portfolio-ledger.js';

const PORTFOLIOS = Object.freeze({
  us: { currency: 'USD', name: 'Yi Capital US' },
  hk: { currency: 'HKD', name: 'Yi Capital HK' },
  a: { currency: 'CNY', name: 'Yi Capital A' },
});
const SOURCES = new Set(['MANUAL', 'AUTOMATION', 'EXCEL', 'MIGRATION', 'LEGACY_API']);
const EVENT_TYPES = new Set([
  'BUY', 'SELL', 'DIVIDEND', 'CORPORATE_ACTION',
  'LIABILITY', 'CAPITAL', 'FUND_ACTION', 'REVERSAL',
]);
const MANUAL_EVENT_TYPES = new Set(['BUY', 'SELL', 'CAPITAL']);
const CASH_PRIORITY = Object.freeze({
  CAPITAL: 0,
  LIABILITY: 1,
  CORPORATE_ACTION: 2,
  BUY: 3,
  SELL: 3,
  DIVIDEND: 4,
  FUND_ACTION: 5,
  REVERSAL: 6,
});
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 280;
const MAX_NAV_SEED_ROWS = 800;
const MAX_PRICE_SEED_ROWS = 500;
const LAYOUT_HASH = 'yicapital-xlsx-v2-11sheet-2f5b7c-d9e2ec';
const textEncoder = new TextEncoder();

class LedgerHttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'LedgerHttpError';
    this.status = status;
    this.details = details;
  }
}

const now = () => Date.now();
function currentHongKongDate(timestamp = now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
const makeId = prefix => prefix + '_' + Date.now().toString(36) + '_' + crypto.randomUUID().replace(/-/g, '');
const upper = value => String(value || '').trim().toUpperCase();
const portfolioId = value => {
  const id = String(value || 'us').trim().toLowerCase();
  if (!PORTFOLIOS[id]) throw new LedgerHttpError(400, 'portfolio 只支持 us/hk/a');
  return id;
};
const ledgerDb = env => {
  const db = env.LEDGER_DB || env.FEEDBACK_DB;
  if (!db) throw new LedgerHttpError(503, 'LEDGER_DB 尚未配置');
  return db;
};

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}
const stableJson = value => JSON.stringify(stableValue(value));
async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new LedgerHttpError(415, 'Content-Type 必須是 application/json');
  }
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_JSON_BYTES) throw new LedgerHttpError(413, '請求內容過大');
  const raw = await request.text();
  if (textEncoder.encode(raw).byteLength > MAX_JSON_BYTES) throw new LedgerHttpError(413, '請求內容過大');
  let body;
  try { body = JSON.parse(raw); } catch (error) { throw new LedgerHttpError(400, 'JSON 格式無效'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LedgerHttpError(400, '請求格式無效');
  }
  return body;
}

function validationProblems(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.errors)) return result.errors;
  if (Array.isArray(result.problems)) return result.problems;
  if (result.ok === false) return [{ severity: 'error', message: result.error || '事件校驗失敗' }];
  return [];
}
function problemSeverity(problem) {
  return upper(problem && (problem.severity || problem.level || problem.type) || 'ERROR');
}
function problemMessage(problem) {
  return String(problem && (problem.message || problem.error || problem.code) || problem || '事件校驗失敗');
}

function canonicalEvent(raw, portfolio) {
  const pf = portfolioId(portfolio);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LedgerHttpError(400, 'event 必須是物件');
  }
  let event;
  try {
    event = normalizeLedgerEvent({
      ...raw,
      portfolio: pf,
      portfolio_id: pf,
      currency: raw.currency || PORTFOLIOS[pf].currency,
    });
  } catch (error) {
    throw new LedgerHttpError(422, error.message || '事件無法標準化');
  }
  const type = upper(event.event_type || event.type);
  if (!EVENT_TYPES.has(type)) throw new LedgerHttpError(422, '不支持的事件類型：' + type);
  event.event_type = type;
  event.type = type;
  event.portfolio = pf;
  event.portfolio_id = pf;
  event.currency = PORTFOLIOS[pf].currency;
  const date = String(event.trade_date || event.date || event.effective_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new LedgerHttpError(422, '事件日期必須是 YYYY-MM-DD');
  event.trade_date = date;
  event.date = date;
  const problems = validationProblems(validateLedgerEvent(event));
  const errors = problems.filter(item => ['ERROR', 'FATAL'].includes(problemSeverity(item)));
  if (errors.length) throw new LedgerHttpError(422, '事件校驗失敗', errors.map(problemMessage));
  return event;
}

function stripSyncFields(event) {
  const copy = { ...event };
  [
    'event_id', 'lineage_id', 'event_version', 'ledger_revision',
    'pending_id', 'confirmed_at', 'confirmed_by', 'created_at',
    'sequence', 'sequence_no', 'legacy_no', 'status', 'source', 'source_ref',
    'portfolio', 'portfolio_id',
    '__yi_event_id', '__yi_event_version', '__yi_base_hash', '__yi_sync_token',
  ].forEach(key => delete copy[key]);
  return copy;
}
const canonicalHash = event => sha256Hex(stableJson(stripSyncFields(event)));

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch (error) { return fallback; }
}
function pendingItem(row) {
  if (!row) return null;
  return {
    pendingId: row.pending_id,
    portfolio: row.portfolio_id,
    eventType: row.event_type,
    tradeDate: row.trade_date,
    event: parseJson(row.payload_json, {}),
    status: row.status,
    version: Number(row.version),
    source: row.source,
    sourceRef: row.source_ref,
    idempotencyKey: row.idempotency_key,
    lineageId: row.lineage_id,
    baseEventId: row.base_event_id,
    baseEventVersion: row.base_event_version == null ? null : Number(row.base_event_version),
    confirmedEventId: row.confirmed_event_id,
    reviewNote: row.review_note,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function eventItem(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    lineageId: row.lineage_id,
    eventVersion: Number(row.event_version),
    portfolio: row.portfolio_id,
    ledgerRevision: Number(row.ledger_revision),
    eventType: row.event_type,
    tradeDate: row.trade_date,
    sequenceNo: Number(row.sequence_no),
    currency: row.currency,
    event: parseJson(row.payload_json, {}),
    grossAmountMinor: row.gross_amount_minor == null ? null : Number(row.gross_amount_minor),
    taxAmountMinor: row.tax_amount_minor == null ? null : Number(row.tax_amount_minor),
    feeAmountMinor: row.fee_amount_minor == null ? null : Number(row.fee_amount_minor),
    netCashMinor: row.net_cash_minor == null ? null : Number(row.net_cash_minor),
    source: row.source,
    sourceRef: row.source_ref,
    supersedesEventId: row.supersedes_event_id,
    reversalOfEventId: row.reversal_of_event_id,
    confirmedBy: row.confirmed_by,
    confirmReason: row.confirm_reason,
    confirmedAt: Number(row.confirmed_at),
  };
}

async function dbAll(db, sql, args = []) {
  const response = await db.prepare(sql).bind(...args).all();
  return response && response.results || [];
}
const dbFirst = (db, sql, args = []) => db.prepare(sql).bind(...args).first();
const chunked = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};
function multiRowInsert(db, table, columns, rows) {
  if (!rows.length) return [];
  const perStatement = Math.max(1, Math.floor(100 / columns.length));
  return chunked(rows, perStatement).map(group => {
    const values = group.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`)
      .bind(...group.flat());
  });
}

async function portfolioRow(db, portfolio) {
  const row = await dbFirst(db, 'SELECT * FROM ledger_portfolios WHERE portfolio_id = ?', [portfolio]);
  if (!row) throw new LedgerHttpError(503, '賬本 migration 尚未套用');
  return row;
}

const ACTIVE_EVENT_SQL = `
  SELECT e.*
  FROM ledger_events e
  WHERE e.portfolio_id = ?
    AND e.ledger_revision <= ?
    AND e.event_type != 'REVERSAL'
    AND NOT EXISTS (
      SELECT 1 FROM ledger_events replacement
      WHERE replacement.supersedes_event_id = e.event_id
        AND replacement.ledger_revision <= ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM ledger_events reversal
      WHERE reversal.reversal_of_event_id = e.event_id
        AND reversal.ledger_revision <= ?
    )
  ORDER BY e.trade_date, e.sequence_no, e.ledger_revision
`;

async function activeEvents(db, portfolio, maxRevision = Number.MAX_SAFE_INTEGER) {
  const revision = Number(maxRevision);
  return (await dbAll(db, ACTIVE_EVENT_SQL, [portfolio, revision, revision, revision])).map(eventItem);
}
function engineEvents(items) {
  return items.map(item => ({
    ...item.event,
    event_id: item.eventId,
    lineage_id: item.lineageId,
    event_version: item.eventVersion,
    ledger_revision: item.ledgerRevision,
    event_type: item.eventType,
    type: item.eventType,
    trade_date: item.tradeDate,
    date: item.tradeDate,
    sequence_no: item.sequenceNo,
    currency: item.currency,
    status: 'confirmed',
  }));
}
function replay(items, portfolio, options = {}) {
  try {
    return replayPortfolioLedger(engineEvents(items), {
      portfolio,
      currency: PORTFOLIOS[portfolio].currency,
      include_pending: false,
      corporate_action_prices: options.corporateActionPrices || [],
      as_of_date: options.asOfDate || currentHongKongDate(),
    });
  } catch (error) {
    throw new LedgerHttpError(422, '賬本重放失敗：' + error.message);
  }
}

function projectionProblems(projection) {
  const checks = projection && (projection.checks || projection.validation || projection.problems) || [];
  return Array.isArray(checks) ? checks : [];
}
function lowestCashMinor(projection) {
  const rows = projection && (projection.cash_chain || projection.cashChain) || [];
  if (!Array.isArray(rows) || !rows.length) return 0;
  const values = rows.map(row => Number(
    row.cash_after_minor ?? row.after_minor ?? row.cashAfterMinor ?? row.balance_minor ?? 0
  )).filter(Number.isFinite);
  return values.length ? Math.min(...values) : 0;
}

async function createPending(db, portfolio, rawEvent, actor, options = {}) {
  const event = canonicalEvent(rawEvent, portfolio);
  event.status = 'pending';
  const source = SOURCES.has(upper(options.source)) ? upper(options.source) : 'MANUAL';
  if (source === 'MANUAL' && !MANUAL_EVENT_TYPES.has(event.event_type)) {
    throw new LedgerHttpError(422,
      '人工新增只允許交易和股東申購/贖回；股息、公司行動、負債與基金行動必須由自動來源進入 Pending。');
  }
  const idempotencyKey = options.idempotencyKey ? String(options.idempotencyKey).slice(0, 200) : null;
  if (idempotencyKey) {
    const existing = await dbFirst(db, `
      SELECT * FROM ledger_pending
      WHERE portfolio_id = ? AND source = ? AND idempotency_key = ?
    `, [portfolio, source, idempotencyKey]);
    if (existing) return { item: pendingItem(existing), duplicate: true };
  }
  const pendingId = makeId('lpd');
  const auditId = makeId('lau');
  const timestamp = now();
  const payload = stableJson(event);
  await db.batch([
    db.prepare(`
      INSERT INTO ledger_pending (
        pending_id, portfolio_id, event_type, trade_date, payload_json,
        status, version, source, source_record_id, source_ref,
        idempotency_key, import_id, lineage_id, base_event_id,
        base_event_version, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      pendingId, portfolio, event.event_type, event.trade_date, payload,
      source, options.sourceRecordId || null, options.sourceRef || null,
      idempotencyKey, options.importId || null, options.lineageId || null,
      options.baseEventId || null, options.baseEventVersion || null,
      actor, actor, timestamp, timestamp
    ),
    db.prepare(`
      INSERT INTO ledger_audit_log (
        audit_id, portfolio_id, actor_type, actor_ref, action,
        target_type, target_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'PENDING_CREATED', 'PENDING', ?, NULL, ?, ?, ?)
    `).bind(
      auditId, portfolio, source === 'AUTOMATION' ? 'SYSTEM' : 'ADMIN', actor,
      pendingId, payload, stableJson({ source, importId: options.importId || null }), timestamp
    ),
  ]);
  const row = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]);
  return { item: pendingItem(row), duplicate: false };
}

function guardStatement(db, values) {
  return db.prepare(`
    INSERT INTO ledger_transaction_guards (
      guard_id, pending_id, expected_pending_version,
      portfolio_id, expected_ledger_revision, created_at
    ) VALUES (
      ?,
      (SELECT pending_id FROM ledger_pending
        WHERE pending_id = ? AND portfolio_id = ? AND status = ? AND version = ?),
      ?,
      (SELECT portfolio_id FROM ledger_portfolios
        WHERE portfolio_id = ? AND ledger_revision = ?),
      ?, ?
    )
  `).bind(
    values.guardId,
    values.pendingId, values.portfolio, values.pendingStatus || 'PENDING', values.pendingVersion,
    values.pendingVersion,
    values.portfolio, values.ledgerRevision,
    values.ledgerRevision, values.timestamp
  );
}

async function updatePending(db, body, actor) {
  const pendingId = String(body.pendingId || '');
  const expectedVersion = Number(body.expectedVersion);
  const current = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]);
  if (!current) throw new LedgerHttpError(404, 'Pending 不存在');
  if (current.status !== 'PENDING') throw new LedgerHttpError(409, 'Pending 已不在待確認狀態');
  if (Number(current.version) !== expectedVersion) throw new LedgerHttpError(409, 'Pending 已被其他操作修改，請刷新');
  const portfolio = current.portfolio_id;
  const pf = await portfolioRow(db, portfolio);
  const event = canonicalEvent(body.event, portfolio);
  event.status = 'pending';
  const timestamp = now();
  const guardId = makeId('ltg');
  const auditId = makeId('lau');
  const payload = stableJson(event);
  try {
    await db.batch([
      guardStatement(db, {
        guardId, pendingId, portfolio, pendingVersion: expectedVersion,
        ledgerRevision: Number(pf.ledger_revision), timestamp,
      }),
      db.prepare(`
        UPDATE ledger_pending SET
          event_type = ?, trade_date = ?, payload_json = ?,
          version = version + 1, updated_by = ?, updated_at = ?
        WHERE pending_id = ? AND status = 'PENDING' AND version = ?
      `).bind(event.event_type, event.trade_date, payload, actor, timestamp, pendingId, expectedVersion),
      db.prepare(`
        INSERT INTO ledger_audit_log (
          audit_id, portfolio_id, actor_type, actor_ref, action,
          target_type, target_id, before_json, after_json, metadata_json, created_at
        ) VALUES (?, ?, 'ADMIN', ?, 'PENDING_UPDATED', 'PENDING', ?, ?, ?, ?, ?)
      `).bind(
        auditId, portfolio, actor, pendingId, current.payload_json, payload,
        stableJson({ fromVersion: expectedVersion, toVersion: expectedVersion + 1 }), timestamp
      ),
      db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
    ]);
  } catch (error) {
    throw new LedgerHttpError(409, 'Pending 已被其他操作修改，請刷新');
  }
  return pendingItem(await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]));
}

async function rejectPending(db, body, actor) {
  const pendingId = String(body.pendingId || '');
  const expectedVersion = Number(body.expectedVersion);
  const reason = String(body.reason || '').trim().slice(0, 1000);
  if (!reason) throw new LedgerHttpError(422, '駁回原因不能為空');
  const current = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]);
  if (!current) throw new LedgerHttpError(404, 'Pending 不存在');
  if (current.status !== 'PENDING' || Number(current.version) !== expectedVersion) {
    throw new LedgerHttpError(409, 'Pending 已被其他操作處理，請刷新');
  }
  const pf = await portfolioRow(db, current.portfolio_id);
  const timestamp = now();
  const guardId = makeId('ltg');
  await db.batch([
    guardStatement(db, {
      guardId, pendingId, portfolio: current.portfolio_id, pendingVersion: expectedVersion,
      ledgerRevision: Number(pf.ledger_revision), timestamp,
    }),
    db.prepare(`
      UPDATE ledger_pending SET status = 'REJECTED', version = version + 1,
        review_note = ?, updated_by = ?, updated_at = ?
      WHERE pending_id = ? AND status = 'PENDING' AND version = ?
    `).bind(reason, actor, timestamp, pendingId, expectedVersion),
    db.prepare(`
      INSERT INTO ledger_audit_log (
        audit_id, portfolio_id, actor_type, actor_ref, action,
        target_type, target_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, 'ADMIN', ?, 'PENDING_REJECTED', 'PENDING', ?, ?, ?, ?, ?)
    `).bind(
      makeId('lau'), current.portfolio_id, actor, pendingId,
      stableJson(pendingItem(current)), stableJson({ status: 'REJECTED', reason }),
      stableJson({ expectedVersion }), timestamp
    ),
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  ]).catch(() => { throw new LedgerHttpError(409, 'Pending 已被其他操作處理，請刷新'); });
  return pendingItem(await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]));
}

function moneyMinor(event, key) {
  const value = event[key];
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function scaledInteger(value, scale, field, nullable = false) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw new LedgerHttpError(422, `${field} 不能為空`);
  }
  const number = Number(value);
  const scaled = Math.round(number * scale);
  if (!Number.isFinite(number) || !Number.isSafeInteger(scaled)) {
    throw new LedgerHttpError(422, `${field} 超出可用數值範圍`);
  }
  return scaled;
}

function canonicalNavSeedRow(raw, portfolio, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LedgerHttpError(422, `第 ${index + 1} 筆 historical_nav_rows 格式無效`);
  }
  const date = String(raw.date || raw.nav_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LedgerHttpError(422, `第 ${index + 1} 筆 NAV 日期必須是 YYYY-MM-DD`);
  }
  const cashMinor = scaledInteger(raw.cash, 100, `${date} cash`);
  const marketValueMinor = scaledInteger(raw.market_value ?? raw.marketValue, 100, `${date} market_value`);
  const totalAssetsMinor = scaledInteger(raw.total_assets ?? raw.totalAssets, 100, `${date} total_assets`);
  const liabilityMinor = scaledInteger(raw.liability, 100, `${date} liability`);
  const liabilityAssetRatioMicros = scaledInteger(
    raw.liability_asset_ratio ?? raw.liabilityAssetRatio ?? (totalAssetsMinor ? liabilityMinor / totalAssetsMinor : 0),
    1_000_000,
    `${date} liability_asset_ratio`,
    true,
  );
  const netValueMinor = scaledInteger(raw.net_value ?? raw.netValue, 100, `${date} net_value`);
  const unitsMicros = scaledInteger(raw.units, 1_000_000, `${date} units`);
  const unitNavMicros = scaledInteger(raw.unit_nav ?? raw.unitNav ?? raw.nav, 1_000_000, `${date} unit_nav`, true);
  const fundActionAdjustmentMinor = scaledInteger(
    raw.fund_action_adjustment ?? raw.fundActionAdjustment ?? 0,
    100,
    `${date} fund_action_adjustment`,
  );
  if (String(raw.currency || PORTFOLIOS[portfolio].currency).toUpperCase() !== PORTFOLIOS[portfolio].currency) {
    throw new LedgerHttpError(422, `${date} NAV 幣種與基金不匹配`);
  }
  if (Math.abs(totalAssetsMinor - cashMinor - marketValueMinor) > 2) {
    throw new LedgerHttpError(422, `${date} NAV 總資產不等於現金加持倉市值`);
  }
  if (Math.abs(netValueMinor - totalAssetsMinor + liabilityMinor) > 2) {
    throw new LedgerHttpError(422, `${date} NAV 淨值不等於總資產減負債`);
  }
  if (unitsMicros < 0 || (unitsMicros > 0 && unitNavMicros == null)) {
    throw new LedgerHttpError(422, `${date} NAV 份額或單位淨值無效`);
  }
  return {
    date,
    cashMinor,
    marketValueMinor,
    totalAssetsMinor,
    liabilityMinor,
    liabilityAssetRatioMicros,
    netValueMinor,
    unitsMicros,
    unitNavMicros,
    fundActionAdjustmentMinor,
    source: 'LEGACY_READ_ONLY_PROJECTION',
    sourceRef: String(raw.source_ref || `${raw.source_sheet || 'NAV Statement'}!${raw.source_row || index + 2}`).slice(0, 240),
    sourceWorkbookSha256: raw.source_workbook_sha256 || null,
    sourceRow: Number.isInteger(Number(raw.source_row)) ? Number(raw.source_row) : null,
    valuation: raw.valuation && typeof raw.valuation === 'object' ? raw.valuation : {},
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

function canonicalPriceSeedRow(raw, portfolio, index, sourceWorkbookSha256) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LedgerHttpError(422, `第 ${index + 1} 筆 historical_price_rows 格式無效`);
  }
  const ticker = String(raw.ticker || raw.symbol || '').trim().toUpperCase().slice(0, 32);
  const date = String(raw.price_date || raw.date || raw.as_of || '').slice(0, 10);
  if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LedgerHttpError(422, `第 ${index + 1} 筆歷史價格缺少 ticker 或有效日期`);
  }
  const priceMicros = scaledInteger(raw.price ?? raw.latest_price, 1_000_000, `${ticker} price`);
  const quantity = Number(raw.quantity ?? raw.qty ?? 0);
  const marketValue = Number(raw.market_value ?? raw.marketValue ?? quantity * priceMicros / 1_000_000);
  if (!(priceMicros > 0) || !(quantity > 0) || !Number.isFinite(marketValue)) {
    throw new LedgerHttpError(422, `${ticker} 歷史價格、數量或市值無效`);
  }
  if (String(raw.currency || PORTFOLIOS[portfolio].currency).toUpperCase() !== PORTFOLIOS[portfolio].currency) {
    throw new LedgerHttpError(422, `${ticker} 歷史價格幣種與基金不匹配`);
  }
  const expectedMarketValue = quantity * priceMicros / 1_000_000;
  if (Math.abs(expectedMarketValue - marketValue) > Math.max(0.05, Math.abs(marketValue) * 1e-6)) {
    throw new LedgerHttpError(422, `${ticker} 歷史價格乘數量不等於市值`);
  }
  return {
    ticker,
    date,
    currency: PORTFOLIOS[portfolio].currency,
    priceMicros,
    source: 'LEGACY_READ_ONLY_PROJECTION',
    sourceRef: String(raw.source_ref || `${raw.source_sheet || 'Asset Position Record'}!${raw.source_row || index + 3}`).slice(0, 240),
    sourceWorkbookSha256,
    sourceRow: Number.isInteger(Number(raw.source_row)) ? Number(raw.source_row) : null,
    valuation: {
      name: String(raw.name || raw.asset_name || '').slice(0, 200),
      quantity,
      marketValue,
      readOnlyProjectionSeed: true,
    },
  };
}

function navSnapshotItem(row) {
  const totalAssetsMinor = Number(row.total_assets_minor);
  const liabilityMinor = Number(row.liability_minor);
  const unitsMicros = Number(row.units_micros);
  const unitNavMicros = row.unit_nav_micros == null ? null : Number(row.unit_nav_micros);
  return {
    date: row.nav_date,
    currency: PORTFOLIOS[row.portfolio_id].currency,
    totalAssets: totalAssetsMinor / 100,
    liability: liabilityMinor / 100,
    liabilityAssetRatio: row.liability_asset_ratio_micros == null
      ? (totalAssetsMinor ? liabilityMinor / totalAssetsMinor : 0)
      : Number(row.liability_asset_ratio_micros) / 1_000_000,
    netValue: Number(row.net_value_minor) / 100,
    units: unitsMicros / 1_000_000,
    unitNav: unitNavMicros == null ? null : unitNavMicros / 1_000_000,
    nav: unitNavMicros == null ? null : unitNavMicros / 1_000_000,
    fundActionAdjustment: Number(row.fund_action_adjustment_minor || 0) / 100,
    cash: Number(row.cash_minor) / 100,
    marketValue: Number(row.market_value_minor) / 100,
    ledgerRevision: Number(row.ledger_revision),
    source: row.source,
    sourceRef: row.source_ref,
    sourceWorkbookSha256: row.source_workbook_sha256,
    sourceRow: row.source_row == null ? null : Number(row.source_row),
    valuation: parseJson(row.valuation_json, {}),
    warnings: parseJson(row.warnings_json, []),
    recalculationRequired: Number(row.recalculation_required || 0) === 1,
  };
}

async function loadNavSnapshots(db, portfolio, maxRevision = Number.MAX_SAFE_INTEGER) {
  const revision = Number(maxRevision);
  const rows = await dbAll(db, `
    SELECT n.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM ledger_events e
        WHERE e.portfolio_id = n.portfolio_id
          AND e.ledger_revision > n.ledger_revision
          AND e.ledger_revision <= ?
          AND (
            e.trade_date <= n.nav_date
            OR EXISTS (
              SELECT 1 FROM ledger_events original
              WHERE original.event_id = e.supersedes_event_id
                AND original.trade_date <= n.nav_date
            )
            OR EXISTS (
              SELECT 1 FROM ledger_events original
              WHERE original.event_id = e.reversal_of_event_id
                AND original.trade_date <= n.nav_date
            )
          )
      ) THEN 1 ELSE 0 END AS recalculation_required
    FROM ledger_nav_snapshots n
    WHERE n.portfolio_id = ? AND n.ledger_revision <= ?
    ORDER BY n.nav_date
  `, [revision, portfolio, revision]);
  return rows.map(navSnapshotItem);
}

async function loadLatestPrices(db, portfolio, maxRevision = Number.MAX_SAFE_INTEGER) {
  const revision = Number(maxRevision);
  const rows = await dbAll(db, `
    SELECT p.* FROM ledger_prices p
    WHERE p.portfolio_id = ? AND p.ledger_revision <= ?
      AND NOT EXISTS (
        SELECT 1 FROM ledger_prices newer
        WHERE newer.portfolio_id = p.portfolio_id AND newer.ticker = p.ticker
          AND newer.ledger_revision <= ?
          AND (newer.price_date > p.price_date OR
            (newer.price_date = p.price_date AND newer.observed_at > p.observed_at))
      )
    ORDER BY p.ticker
  `, [portfolio, revision, revision]);
  return rows.map(row => ({
    ticker: row.ticker,
    date: row.price_date,
    price: Number(row.price_micros) / 1_000_000,
    ledgerRevision: Number(row.ledger_revision),
    source: row.source,
    sourceRef: row.source_ref,
    valuation: parseJson(row.valuation_json, {}),
  }));
}

async function loadPriceHistory(db, portfolio, maxRevision = Number.MAX_SAFE_INTEGER) {
  const revision = Number(maxRevision);
  const rows = await dbAll(db, `
    SELECT * FROM ledger_prices
    WHERE portfolio_id = ? AND ledger_revision <= ?
    ORDER BY price_date, ticker
  `, [portfolio, revision]);
  return rows.map(row => ({
    ticker: row.ticker,
    date: row.price_date,
    price: Number(row.price_micros) / 1_000_000,
    ledgerRevision: Number(row.ledger_revision),
    source: row.source,
    sourceRef: row.source_ref,
    valuation: parseJson(row.valuation_json, {}),
  }));
}

function enrichProjectionPrices(projection, priceRows) {
  if (!projection || !Array.isArray(projection.positions)) return projection;
  const prices = new Map((priceRows || []).map(row => [row.ticker, row]));
  const active = projection.positions.filter(row => Number(row.quantity ?? row.qty ?? 0) > 0.001)
    .map(row => {
      const quantity = Number(row.quantity ?? row.qty ?? 0);
      const observation = prices.get(String(row.ticker || '').toUpperCase());
      const price = Number((observation && observation.price) ?? row.reference_price ?? row.fallback_price ?? row.price ?? 0);
      const marketValue = quantity * price;
      const buyCost = Number(row.total_buy_cost ?? row.buy_cost ?? 0);
      const sellProceeds = Number(row.total_sell_proceeds ?? row.sell_proceeds ?? 0);
      const dividendIncome = Number(row.dividend_income ?? 0);
      const netCost = Number(row.net_cost ?? buyCost - sellProceeds);
      const totalPnl = marketValue + sellProceeds + dividendIncome - buyCost;
      const averageCost = quantity ? netCost / quantity : 0;
      return {
        ...row,
        latest_price: price,
        price,
        market_value: marketValue,
        total_buy_cost: buyCost,
        total_sell_proceeds: sellProceeds,
        dividend_income: dividendIncome,
        net_cost: netCost,
        total_pnl: totalPnl,
        average_cost: averageCost,
        nominal_return: Math.abs(averageCost) > 0.001 ? (price - averageCost) / Math.abs(averageCost) : null,
        exposure_return: buyCost ? totalPnl / Math.abs(buyCost) : null,
        price_date: observation && observation.date || null,
        price_source: observation && observation.source || row.fallback_price_source || 'ledger-fallback',
      };
    });
  const totalMarketValue = active.reduce((sum, row) => sum + Number(row.market_value || 0), 0);
  projection.positions = active.map(row => ({
    ...row,
    weight: totalMarketValue ? Number(row.market_value) / totalMarketValue : 0,
  }));
  projection.as_of = (priceRows || []).map(row => row.date).filter(Boolean).sort().at(-1) || null;
  return projection;
}

function fundActionAdjustmentByDate(items) {
  const totals = {};
  for (const item of items) {
    if (item.eventType !== 'FUND_ACTION') continue;
    const event = item.event || {};
    const value = Number(event.cash_amount ?? event.net_cash ?? 0);
    if (!Number.isFinite(value) || value >= 0) continue;
    totals[item.tradeDate] = (totals[item.tradeDate] || 0) + value;
  }
  return totals;
}

function fundDividendByDate(items) {
  const totals = {};
  for (const item of items) {
    if (item.eventType !== 'FUND_ACTION') continue;
    const event = item.event || {};
    const cash = Number(event.cash_amount ?? event.net_cash ?? 0);
    const actionType = upper(event.action_type || event.fund_action_type || event.type_name);
    if (!Number.isFinite(cash) || cash >= 0 || actionType.includes('FEE') || actionType.includes('管理')) continue;
    totals[item.tradeDate] = (totals[item.tradeDate] || 0) - cash;
  }
  return totals;
}

function historyFromNav(navRows, items) {
  if (!Array.isArray(navRows) || navRows.length < 2) return [];
  const explicitDates = new Set();
  const dividends = {};
  for (const item of items) {
    if (item.eventType !== 'FUND_ACTION') continue;
    const event = item.event || {};
    const cash = Number(event.cash_amount ?? event.net_cash ?? 0);
    if (!Number.isFinite(cash) || cash >= 0) continue;
    explicitDates.add(item.tradeDate);
    const actionType = upper(event.action_type || event.fund_action_type || event.type_name);
    if (!actionType.includes('FEE') && !actionType.includes('管理')) {
      dividends[item.tradeDate] = (dividends[item.tradeDate] || 0) - cash;
    }
  }
  const history = [];
  for (let index = 1; index < navRows.length; index++) {
    const row = navRows[index];
    const previous = navRows[index - 1];
    const currentNav = Number(row.unitNav);
    const previousNav = Number(previous.unitNav);
    if (!(currentNav > 0) || !(previousNav > 0)) continue;
    const dividendAmount = explicitDates.has(row.date)
      ? Number(dividends[row.date] || 0)
      : Math.max(0, -Number(row.fundActionAdjustment || 0));
    const divPerUnit = Number(row.units) > 0 ? dividendAmount / Number(row.units) : 0;
    history.push({
      date: row.date,
      ret: (currentNav + divPerUnit) / previousNav - 1,
      unitNav: currentNav,
      divPerUnit,
    });
  }
  return history;
}

export async function persistLedgerValuation(
  env,
  requestedPortfolio,
  rawSnapshot,
  rawPrices = [],
  expectedLedgerRevision,
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const revision = Number(expectedLedgerRevision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new LedgerHttpError(409, 'NAV 寫入缺少有效 ledger revision');
  }
  const row = canonicalNavSeedRow({
    date: rawSnapshot.date,
    currency: PORTFOLIOS[portfolio].currency,
    cash: rawSnapshot.cash,
    market_value: rawSnapshot.marketValue,
    total_assets: rawSnapshot.totalAssets,
    liability: rawSnapshot.liability,
    liability_asset_ratio: Number(rawSnapshot.totalAssets)
      ? Number(rawSnapshot.liability) / Number(rawSnapshot.totalAssets)
      : 0,
    net_value: rawSnapshot.netValue,
    units: rawSnapshot.units,
    unit_nav: rawSnapshot.unitNav,
    fund_action_adjustment: rawSnapshot.fundActionAdjustment || 0,
    valuation: rawSnapshot.valuation || {},
    warnings: rawSnapshot.warnings || [],
  }, portfolio, 0);
  row.source = 'TUSHARE';
  row.sourceRef = String(rawSnapshot.sourceRef || 'portfolio-eod').slice(0, 240);
  row.sourceWorkbookSha256 = null;
  row.sourceRow = null;
  const timestamp = now();
  const prices = (Array.isArray(rawPrices) ? rawPrices : []).map((price, index) => {
    const ticker = String(price.ticker || price.t || '').trim().toUpperCase().slice(0, 32);
    const date = String(price.date || row.date).slice(0, 10);
    if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new LedgerHttpError(422, `第 ${index + 1} 筆估值價格格式無效`);
    }
    return {
      portfolio_id: portfolio,
      ticker,
      price_date: date,
      ledger_revision: revision,
      price_micros: scaledInteger(price.close ?? price.price, 1_000_000, `${ticker} price`),
      currency: PORTFOLIOS[portfolio].currency,
      source: String(price.source || 'TUSHARE').slice(0, 100),
      source_ref: String(price.sourceRef || price.source_endpoint || '').slice(0, 240) || null,
      valuation_json: stableJson(price.valuation && typeof price.valuation === 'object' ? price.valuation : {}),
      observed_at: timestamp,
    };
  });
  const guardId = makeId('ltg');
  const statements = [db.prepare(`
    INSERT INTO ledger_transaction_guards (
      guard_id, pending_id, expected_pending_version,
      portfolio_id, expected_ledger_revision, created_at
    ) VALUES (
      ?, ?, 1,
      (SELECT portfolio_id FROM ledger_portfolios WHERE portfolio_id = ? AND ledger_revision = ?),
      ?, ?
    )
  `).bind(guardId, `nav:${portfolio}:${row.date}`, portfolio, revision, revision, timestamp)];
  if (prices.length) {
    statements.push(db.prepare(`
      INSERT INTO ledger_prices (
        portfolio_id, ticker, price_date, ledger_revision, price_micros,
        currency, source, source_ref, source_workbook_sha256, source_row,
        valuation_json, observed_at
      )
      SELECT
        json_extract(value, '$.portfolio_id'), json_extract(value, '$.ticker'),
        json_extract(value, '$.price_date'), json_extract(value, '$.ledger_revision'),
        json_extract(value, '$.price_micros'), json_extract(value, '$.currency'),
        json_extract(value, '$.source'), json_extract(value, '$.source_ref'),
        NULL, NULL, json_extract(value, '$.valuation_json'),
        json_extract(value, '$.observed_at')
      FROM json_each(?) WHERE true
      ON CONFLICT(portfolio_id, ticker, price_date) DO UPDATE SET
        ledger_revision = excluded.ledger_revision,
        price_micros = excluded.price_micros,
        currency = excluded.currency,
        source = excluded.source,
        source_ref = excluded.source_ref,
        source_workbook_sha256 = NULL,
        source_row = NULL,
        valuation_json = excluded.valuation_json,
        observed_at = excluded.observed_at
      WHERE excluded.ledger_revision >= ledger_prices.ledger_revision
    `).bind(stableJson(prices)));
  }
  statements.push(
    db.prepare(`
      INSERT INTO ledger_nav_snapshots (
        portfolio_id, nav_date, ledger_revision, cash_minor, market_value_minor,
        total_assets_minor, liability_minor, liability_asset_ratio_micros,
        net_value_minor, units_micros, unit_nav_micros,
        fund_action_adjustment_minor, source, source_ref,
        source_workbook_sha256, source_row, valuation_json, warnings_json, calculated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(portfolio_id, nav_date) DO UPDATE SET
        ledger_revision = excluded.ledger_revision,
        cash_minor = excluded.cash_minor,
        market_value_minor = excluded.market_value_minor,
        total_assets_minor = excluded.total_assets_minor,
        liability_minor = excluded.liability_minor,
        liability_asset_ratio_micros = excluded.liability_asset_ratio_micros,
        net_value_minor = excluded.net_value_minor,
        units_micros = excluded.units_micros,
        unit_nav_micros = excluded.unit_nav_micros,
        fund_action_adjustment_minor = excluded.fund_action_adjustment_minor,
        source = excluded.source,
        source_ref = excluded.source_ref,
        source_workbook_sha256 = NULL,
        source_row = NULL,
        valuation_json = excluded.valuation_json,
        warnings_json = excluded.warnings_json,
        calculated_at = excluded.calculated_at
      WHERE excluded.ledger_revision >= ledger_nav_snapshots.ledger_revision
    `).bind(
      portfolio, row.date, revision, row.cashMinor, row.marketValueMinor,
      row.totalAssetsMinor, row.liabilityMinor, row.liabilityAssetRatioMicros,
      row.netValueMinor, row.unitsMicros, row.unitNavMicros,
      row.fundActionAdjustmentMinor, row.source, row.sourceRef,
      stableJson(row.valuation), stableJson(row.warnings), timestamp,
    ),
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    throw new LedgerHttpError(409, 'NAV 寫入時賬本 revision 已改變');
  }
  return navSnapshotItem({
    portfolio_id: portfolio,
    nav_date: row.date,
    ledger_revision: revision,
    cash_minor: row.cashMinor,
    market_value_minor: row.marketValueMinor,
    total_assets_minor: row.totalAssetsMinor,
    liability_minor: row.liabilityMinor,
    liability_asset_ratio_micros: row.liabilityAssetRatioMicros,
    net_value_minor: row.netValueMinor,
    units_micros: row.unitsMicros,
    unit_nav_micros: row.unitNavMicros,
    fund_action_adjustment_minor: row.fundActionAdjustmentMinor,
    source: row.source,
    source_ref: row.sourceRef,
    source_workbook_sha256: null,
    source_row: null,
    valuation_json: stableJson(row.valuation),
    warnings_json: stableJson(row.warnings),
    recalculation_required: 0,
  });
}

export async function persistLedgerValuationBatch(
  env,
  requestedPortfolio,
  rawBatch,
  expectedLedgerRevision,
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const revision = Number(expectedLedgerRevision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new LedgerHttpError(409, '歷史 NAV 寫入缺少有效 ledger revision');
  }
  const batch = rawBatch && typeof rawBatch === 'object' ? rawBatch : {};
  const replaceFrom = String(batch.replaceFrom || '').slice(0, 10);
  const replaceThrough = String(batch.replaceThrough || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(replaceFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(replaceThrough) || replaceFrom > replaceThrough) {
    throw new LedgerHttpError(422, '歷史 NAV 替換日期範圍無效');
  }
  const rawRows = Array.isArray(batch.navRows) ? batch.navRows : [];
  if (!rawRows.length || rawRows.length > MAX_NAV_SEED_ROWS) {
    throw new LedgerHttpError(422, '歷史 NAV 重建行數無效');
  }
  const timestamp = now();
  const seenDates = new Set();
  const navRows = rawRows.map((raw, index) => {
    const row = canonicalNavSeedRow(raw, portfolio, index);
    if (row.date < replaceFrom || row.date > replaceThrough || seenDates.has(row.date)) {
      throw new LedgerHttpError(422, `歷史 NAV 日期超出範圍或重複：${row.date}`);
    }
    seenDates.add(row.date);
    return {
      ...row,
      portfolio_id: portfolio,
      ledger_revision: revision,
      source: 'TUSHARE',
      sourceRef: String(raw.sourceRef || raw.source_ref || 'historical-nav-replay').slice(0, 240),
      sourceWorkbookSha256: null,
      sourceRow: null,
      valuation_json: stableJson(raw.valuation && typeof raw.valuation === 'object' ? raw.valuation : {}),
      warnings_json: stableJson(Array.isArray(raw.warnings) ? raw.warnings : []),
      calculated_at: timestamp,
    };
  }).sort((left, right) => left.date.localeCompare(right.date));
  const priceKeys = new Set();
  const priceRows = (Array.isArray(batch.priceRows) ? batch.priceRows : []).map((raw, index) => {
    const ticker = String(raw.ticker || raw.symbol || '').trim().toUpperCase().slice(0, 32);
    const date = String(raw.date || raw.price_date || '').slice(0, 10);
    const key = `${ticker}:${date}`;
    if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(date) || priceKeys.has(key)) {
      throw new LedgerHttpError(422, `第 ${index + 1} 筆歷史價格格式無效或重複`);
    }
    priceKeys.add(key);
    return {
      portfolio_id: portfolio,
      ticker,
      price_date: date,
      ledger_revision: revision,
      price_micros: scaledInteger(raw.close ?? raw.price, 1_000_000, `${ticker} price`),
      currency: PORTFOLIOS[portfolio].currency,
      source: String(raw.source || 'TUSHARE').slice(0, 100),
      source_ref: String(raw.sourceRef || raw.source_ref || '').slice(0, 240) || null,
      valuation_json: stableJson(raw.valuation && typeof raw.valuation === 'object' ? raw.valuation : {}),
      observed_at: timestamp,
    };
  });
  const guardId = makeId('ltg');
  const statements = [
    db.prepare(`
      INSERT INTO ledger_transaction_guards (
        guard_id, pending_id, expected_pending_version,
        portfolio_id, expected_ledger_revision, created_at
      ) VALUES (
        ?, ?, 1,
        (SELECT portfolio_id FROM ledger_portfolios WHERE portfolio_id = ? AND ledger_revision = ?),
        ?, ?
      )
    `).bind(
      guardId, `nav-history:${portfolio}:${replaceFrom}`,
      portfolio, revision, revision, timestamp,
    ),
    db.prepare(`
      DELETE FROM ledger_nav_snapshots
      WHERE portfolio_id = ? AND nav_date >= ? AND nav_date <= ?
    `).bind(portfolio, replaceFrom, replaceThrough),
  ];
  if (priceRows.length) {
    statements.push(db.prepare(`
      INSERT INTO ledger_prices (
        portfolio_id, ticker, price_date, ledger_revision, price_micros,
        currency, source, source_ref, source_workbook_sha256, source_row,
        valuation_json, observed_at
      )
      SELECT
        json_extract(value, '$.portfolio_id'), json_extract(value, '$.ticker'),
        json_extract(value, '$.price_date'), json_extract(value, '$.ledger_revision'),
        json_extract(value, '$.price_micros'), json_extract(value, '$.currency'),
        json_extract(value, '$.source'), json_extract(value, '$.source_ref'),
        NULL, NULL, json_extract(value, '$.valuation_json'),
        json_extract(value, '$.observed_at')
      FROM json_each(?) WHERE true
      ON CONFLICT(portfolio_id, ticker, price_date) DO UPDATE SET
        ledger_revision = excluded.ledger_revision,
        price_micros = excluded.price_micros,
        currency = excluded.currency,
        source = excluded.source,
        source_ref = excluded.source_ref,
        source_workbook_sha256 = NULL,
        source_row = NULL,
        valuation_json = excluded.valuation_json,
        observed_at = excluded.observed_at
      WHERE excluded.ledger_revision >= ledger_prices.ledger_revision
    `).bind(stableJson(priceRows)));
  }
  statements.push(
    db.prepare(`
      INSERT INTO ledger_nav_snapshots (
        portfolio_id, nav_date, ledger_revision, cash_minor, market_value_minor,
        total_assets_minor, liability_minor, liability_asset_ratio_micros,
        net_value_minor, units_micros, unit_nav_micros,
        fund_action_adjustment_minor, source, source_ref,
        source_workbook_sha256, source_row, valuation_json, warnings_json, calculated_at
      )
      SELECT
        json_extract(value, '$.portfolio_id'), json_extract(value, '$.date'),
        json_extract(value, '$.ledger_revision'), json_extract(value, '$.cashMinor'),
        json_extract(value, '$.marketValueMinor'), json_extract(value, '$.totalAssetsMinor'),
        json_extract(value, '$.liabilityMinor'), json_extract(value, '$.liabilityAssetRatioMicros'),
        json_extract(value, '$.netValueMinor'), json_extract(value, '$.unitsMicros'),
        json_extract(value, '$.unitNavMicros'), json_extract(value, '$.fundActionAdjustmentMinor'),
        json_extract(value, '$.source'), json_extract(value, '$.sourceRef'),
        NULL, NULL, json_extract(value, '$.valuation_json'),
        json_extract(value, '$.warnings_json'), json_extract(value, '$.calculated_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(navRows)),
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    throw new LedgerHttpError(409, '歷史 NAV 重建寫入時賬本 revision 已變更');
  }
  return {
    ok: true,
    portfolio,
    ledgerRevision: revision,
    replaceFrom,
    replaceThrough,
    navRowCount: navRows.length,
    priceRowCount: priceRows.length,
  };
}

async function confirmPending(db, env, body, actor) {
  const pendingId = String(body.pendingId || '');
  const expectedVersion = Number(body.expectedVersion);
  const confirmation = body.confirmation && typeof body.confirmation === 'object' ? body.confirmation : {};
  const reason = String(confirmation.reason || '').trim().slice(0, 1000);
  const current = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]);
  if (!current) throw new LedgerHttpError(404, 'Pending 不存在');
  if (current.status !== 'PENDING' || Number(current.version) !== expectedVersion) {
    throw new LedgerHttpError(409, 'Pending 已被其他操作處理，請刷新');
  }
  const portfolio = current.portfolio_id;
  const portfolioState = await portfolioRow(db, portfolio);
  const event = canonicalEvent(parseJson(current.payload_json, {}), portfolio);
  event.status = 'confirmed';
  if (event.trade_date > currentHongKongDate()) {
    throw new LedgerHttpError(422, '未到生效日期的事件必須保留在 Pending，不能提前確認');
  }
  const [beforeItems, corporateActionPrices] = await Promise.all([
    activeEvents(db, portfolio, Number(portfolioState.ledger_revision)),
    loadPriceHistory(db, portfolio, Number(portfolioState.ledger_revision)),
  ]);
  const replayOptions = { corporateActionPrices };
  const beforeProjection = replay(beforeItems, portfolio, replayOptions);
  const baseEventId = current.base_event_id || null;
  let baseEvent = null;
  if (baseEventId) {
    baseEvent = beforeItems.find(item => item.eventId === baseEventId);
    if (!baseEvent) throw new LedgerHttpError(409, '原事件已被修改或作廢，請重新匯入/預覽');
  }
  const eventId = makeId('lev');
  const lineageId = current.lineage_id || (baseEvent && baseEvent.lineageId) || eventId;
  const eventVersion = baseEvent ? baseEvent.eventVersion + 1 : 1;
  const revision = Number(portfolioState.ledger_revision) + 1;
  const previewItem = {
    eventId, lineageId, eventVersion, portfolio, ledgerRevision: revision,
    eventType: event.event_type, tradeDate: event.trade_date,
    sequenceNo: revision,
    currency: PORTFOLIOS[portfolio].currency, event,
  };
  const previewItems = baseEvent
    ? beforeItems.filter(item => item.eventId !== baseEvent.eventId).concat(previewItem)
    : beforeItems.concat(previewItem);
  const afterProjection = replay(previewItems, portfolio, replayOptions);
  const fatal = projectionProblems(afterProjection)
    .filter(item => ['ERROR', 'FATAL'].includes(problemSeverity(item)));
  if (fatal.length) {
    throw new LedgerHttpError(422, '確認後賬本校驗失敗', fatal.map(problemMessage));
  }
  // Match the Python manager exactly: negative cash is a visible warning from
  // replay, never an additional confirmation blocker.
  const timestamp = now();
  const guardId = makeId('ltg');
  const payload = stableJson(event);
  const source = current.source;
  const reversalTarget = event.reversal_of_event_id
    ? beforeItems.find(item => item.eventId === event.reversal_of_event_id)
    : null;
  const affectedFrom = [
    event.trade_date,
    baseEvent && baseEvent.tradeDate,
    reversalTarget && reversalTarget.tradeDate,
  ].filter(Boolean).sort()[0];
  const outboxPayload = stableJson({ eventId, pendingId, affectedFrom });
  try {
    await db.batch([
      guardStatement(db, {
        guardId, pendingId, portfolio, pendingVersion: expectedVersion,
        ledgerRevision: Number(portfolioState.ledger_revision), timestamp,
      }),
      db.prepare(`
        UPDATE ledger_portfolios
        SET ledger_revision = ?, updated_at = ?
        WHERE portfolio_id = ? AND ledger_revision = ?
      `).bind(revision, timestamp, portfolio, Number(portfolioState.ledger_revision)),
      db.prepare(`
        INSERT INTO ledger_events (
          event_id, lineage_id, event_version, portfolio_id, ledger_revision,
          event_type, trade_date, sequence_no, currency, payload_json,
          gross_amount_minor, tax_amount_minor, fee_amount_minor, net_cash_minor,
          source, source_ref, idempotency_key, supersedes_event_id,
          reversal_of_event_id, pending_id, confirmed_by, confirm_reason, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId, lineageId, eventVersion, portfolio, revision,
        event.event_type, event.trade_date, revision,
        PORTFOLIOS[portfolio].currency, payload,
        moneyMinor(event, 'gross_amount_minor'), moneyMinor(event, 'tax_amount_minor'),
        moneyMinor(event, 'fee_amount_minor'), moneyMinor(event, 'net_cash_minor'),
        source, current.source_ref, current.idempotency_key, baseEventId,
        event.event_type === 'REVERSAL' ? (event.reversal_of_event_id || null) : null,
        pendingId, actor, reason, timestamp
      ),
      db.prepare(`
        UPDATE ledger_pending SET status = 'CONFIRMED', version = version + 1,
          confirmed_event_id = ?, review_note = ?, updated_by = ?, updated_at = ?
        WHERE pending_id = ? AND status = 'PENDING' AND version = ?
      `).bind(eventId, reason, actor, timestamp, pendingId, expectedVersion),
      db.prepare(`
        INSERT INTO ledger_audit_log (
          audit_id, portfolio_id, actor_type, actor_ref, action,
          target_type, target_id, before_json, after_json, metadata_json, created_at
        ) VALUES (?, ?, 'ADMIN', ?, 'EVENT_CONFIRMED', 'EVENT', ?, ?, ?, ?, ?)
      `).bind(
        makeId('lau'), portfolio, actor, eventId,
        stableJson(pendingItem(current)),
        stableJson({ eventId, lineageId, eventVersion, ledgerRevision: revision, event }),
        stableJson({ reason, negativeCashWarningOnly: true, baseEventId }), timestamp
      ),
      ...['REBUILD_KV', 'REBUILD_EXCEL', 'RECALC_NAV'].map(kind => db.prepare(`
        INSERT INTO ledger_outbox (
          outbox_id, portfolio_id, ledger_revision, kind, payload_json,
          status, attempts, available_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)
      `).bind(makeId('lob'), portfolio, revision, kind, outboxPayload, timestamp, timestamp)),
      db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
    ]);
  } catch (error) {
    if (error instanceof LedgerHttpError) throw error;
    throw new LedgerHttpError(409, '確認時賬本已改變，請刷新後重試');
  }
  await materializeLedgerKv(env, portfolio).catch(error => console.error('ledger_kv_materialize_failed', portfolio, error));
  return {
    item: eventItem(await dbFirst(db, 'SELECT * FROM ledger_events WHERE event_id = ?', [eventId])),
    ledgerRevision: revision,
    projection: afterProjection,
  };
}

async function createExport(db, portfolio, actor) {
  const state = await portfolioRow(db, portfolio);
  const ledgerRevision = Number(state.ledger_revision);
  const [events, navRows, priceRows, priceHistory] = await Promise.all([
    activeEvents(db, portfolio, ledgerRevision),
    loadNavSnapshots(db, portfolio, ledgerRevision),
    loadLatestPrices(db, portfolio, ledgerRevision),
    loadPriceHistory(db, portfolio, ledgerRevision),
  ]);
  const projection = enrichProjectionPrices(replay(events, portfolio, {
    corporateActionPrices: priceHistory,
  }), priceRows);
  projection.nav_rows = navRows;
  const exportId = makeId('lex');
  const syncToken = makeId('lst');
  const tokenHash = await sha256Hex(syncToken);
  const snapshotEvents = {};
  for (const item of events) {
    snapshotEvents[item.lineageId] = {
      eventId: item.eventId,
      lineageId: item.lineageId,
      eventVersion: item.eventVersion,
      hash: await canonicalHash(item.event),
      event: item.event,
    };
  }
  const snapshot = {
    schemaVersion: 1,
    portfolio,
    currency: PORTFOLIOS[portfolio].currency,
    ledgerRevision,
    layoutHash: LAYOUT_HASH,
    events: snapshotEvents,
  };
  await db.prepare(`
    INSERT INTO ledger_exports (
      export_id, portfolio_id, ledger_revision, layout_hash,
      sync_token_hash, snapshot_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    exportId, portfolio, ledgerRevision, LAYOUT_HASH,
    tokenHash, stableJson(snapshot), actor, now()
  ).run();
  return {
    portfolio,
    currency: PORTFOLIOS[portfolio].currency,
    ledgerRevision,
    events,
    navRows,
    priceRows,
    projection,
    exportId,
    syncToken,
    layoutHash: LAYOUT_HASH,
  };
}

async function validateExportToken(db, body, portfolio) {
  if (!body.exportId) return { exportRow: null, snapshot: null, warning: 'UNSIGNED_LEGACY_WORKBOOK' };
  const row = await dbFirst(db, `
    SELECT * FROM ledger_exports WHERE export_id = ? AND portfolio_id = ?
  `, [String(body.exportId), portfolio]);
  if (!row) throw new LedgerHttpError(403, 'Excel export_id 無效或基金不匹配');
  if (!body.syncToken || await sha256Hex(String(body.syncToken)) !== row.sync_token_hash) {
    throw new LedgerHttpError(403, 'Excel 同步簽名無效，請從後台重新導出');
  }
  return { exportRow: row, snapshot: parseJson(row.snapshot_json, {}), warning: null };
}

function excelRowPayload(row) {
  if (row.event && typeof row.event === 'object') return row.event;
  if (row.payload && typeof row.payload === 'object') return row.payload;
  const copy = { ...row };
  [
    'sheetName', 'sheet', 'rowNumber', 'row', 'eventId', 'lineageId',
    'eventVersion', 'baseHash', 'derived', 'operationId',
  ].forEach(key => delete copy[key]);
  return copy;
}

async function previewImport(db, body, actor) {
  const portfolio = portfolioId(body.portfolio);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) throw new LedgerHttpError(400, 'rows 必須是陣列');
  if (rows.length > MAX_IMPORT_ROWS) throw new LedgerHttpError(413, 'Excel 事件行過多');
  const sha = String(body.uploadSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new LedgerHttpError(400, 'uploadSha256 無效');
  const fileName = String(body.fileName || 'ledger.xlsx').slice(0, 240);
  const existing = await dbFirst(db, `
    SELECT * FROM ledger_imports WHERE portfolio_id = ? AND upload_sha256 = ?
  `, [portfolio, sha]);
  if (existing && existing.status === 'CONFIRMED') {
    return { ...parseJson(existing.preview_json, {}), importId: existing.import_id, duplicateUpload: true };
  }
  if (existing) {
    await db.prepare('DELETE FROM ledger_imports WHERE import_id = ?').bind(existing.import_id).run();
  }
  const state = await portfolioRow(db, portfolio);
  const token = await validateExportToken(db, body, portfolio);
  if (!token.exportRow && Number(state.ledger_revision) > 0) {
    throw new LedgerHttpError(403, '已有賬本只接受由後台導出且簽名有效的 Excel；舊工作簿請走首次遷移');
  }
  const baseRevision = Number(
    body.baseLedgerRevision ?? (token.exportRow ? token.exportRow.ledger_revision : state.ledger_revision)
  );
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new LedgerHttpError(400, 'baseLedgerRevision 無效');
  const currentEvents = await activeEvents(db, portfolio, Number(state.ledger_revision));
  const currentByLineage = new Map(currentEvents.map(item => [item.lineageId, item]));
  const currentByHash = new Map();
  for (const item of currentEvents) currentByHash.set(await canonicalHash(item.event), item);
  const baseEvents = token.snapshot && token.snapshot.events || {};
  const seenLineages = new Set();
  const operations = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || {};
    const sheetName = String(row.sheetName || row.sheet || 'Unknown').slice(0, 100);
    const rowNumber = Math.max(1, Number(row.rowNumber || row.row || index + 1) || index + 1);
    const operationId = makeId('lio');
    if (row.derived === true) {
      operations.push({ operationId, operation: 'IGNORED_DERIVED', sheetName, rowNumber });
      continue;
    }
    let event;
    try { event = canonicalEvent(excelRowPayload(row), portfolio); } catch (error) {
      operations.push({
        operationId, operation: 'ERROR', sheetName, rowNumber,
        error: error.message, details: error.details || null,
      });
      continue;
    }
    const excelHash = await canonicalHash(event);
    const lineageId = String(row.lineageId || row.eventId || row.__yi_event_id || '').trim() || null;
    if (!lineageId) {
      const duplicate = currentByHash.get(excelHash);
      const createAllowed = MANUAL_EVENT_TYPES.has(event.event_type);
      operations.push({
        operationId,
        operation: duplicate ? 'NOOP' : createAllowed ? 'CREATE' : 'ERROR',
        reason: duplicate ? 'EXACT_DUPLICATE' : createAllowed
          ? null
          : 'AUTOMATION_EVENT_CREATE_FORBIDDEN',
        error: duplicate || createAllowed
          ? null
          : '股息、公司行動、負債與基金行動只能更新已有自動 Pending，不能由 Excel 新建事實。',
        sheetName, rowNumber, excel: event, excelHash,
        eventId: duplicate && duplicate.eventId || null,
        lineageId: duplicate && duplicate.lineageId || null,
      });
      continue;
    }
    if (seenLineages.has(lineageId)) {
      operations.push({ operationId, operation: 'CONFLICT', reason: 'DUPLICATE_EVENT_ID', sheetName, rowNumber, lineageId, excel: event });
      continue;
    }
    seenLineages.add(lineageId);
    const current = currentByLineage.get(lineageId);
    const base = baseEvents[lineageId] || null;
    if (!current) {
      operations.push({ operationId, operation: 'CONFLICT', reason: 'UNKNOWN_OR_INACTIVE_EVENT_ID', sheetName, rowNumber, lineageId, excel: event });
      continue;
    }
    const currentHash = await canonicalHash(current.event);
    const baseHash = base && base.hash || String(row.baseHash || row.__yi_base_hash || '') || null;
    let operation = 'CONFLICT';
    let reason = 'BOTH_CHANGED';
    if (excelHash === currentHash) { operation = 'NOOP'; reason = null; }
    else if (baseHash && currentHash === baseHash) { operation = 'UPDATE'; reason = null; }
    else if (baseHash && excelHash === baseHash) { operation = 'NOOP'; reason = 'DATABASE_CHANGED_EXCEL_UNCHANGED'; }
    else if (!baseHash) { reason = 'MISSING_BASE_SNAPSHOT'; }
    operations.push({
      operationId, operation, reason, sheetName, rowNumber,
      eventId: current.eventId, lineageId, baseEventVersion: current.eventVersion,
      base: base && base.event || null, current: current.event, excel: event,
      baseHash, currentHash, excelHash,
    });
  }
  if (seenLineages.size || token.exportRow) {
    for (const item of currentEvents) {
      if (!seenLineages.has(item.lineageId)) {
        operations.push({
          operationId: makeId('lio'), operation: 'MISSING_IN_EXCEL',
          reason: 'DELETE_REQUIRES_EXPLICIT_VOID', sheetName: '', rowNumber: 1,
          eventId: item.eventId, lineageId: item.lineageId, current: item.event,
        });
      }
    }
  }
  const summary = operations.reduce((acc, item) => {
    acc[item.operation] = (acc[item.operation] || 0) + 1;
    return acc;
  }, {});
  const importId = makeId('lim');
  const preview = {
    ok: true, importId, portfolio, currency: PORTFOLIOS[portfolio].currency,
    baseLedgerRevision: baseRevision, currentLedgerRevision: Number(state.ledger_revision),
    signed: !!token.exportRow, warning: token.warning, summary, operations,
  };
  const timestamp = now();
  const statements = [
    db.prepare(`
      INSERT INTO ledger_imports (
        import_id, portfolio_id, file_name, upload_sha256, export_id,
        base_ledger_revision, status, preview_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PREVIEWED', ?, ?, ?)
    `).bind(
      importId, portfolio, fileName, sha, token.exportRow && token.exportRow.export_id || null,
      baseRevision, stableJson(preview), actor, timestamp
    ),
  ];
  const importRows = [];
  for (const item of operations) {
    // NOOP/derived rows remain in preview_json but do not need one D1 row each.
    // This keeps a full historical workbook under the D1 per-invocation query limit.
    if (['NOOP', 'IGNORED_DERIVED'].includes(item.operation)) continue;
    importRows.push([
      item.operationId, importId, item.sheetName || '—', item.rowNumber || 1, item.operation,
      item.eventId || null, item.baseEventVersion || null,
      item.base ? stableJson(item.base) : null,
      item.excel ? stableJson(item.excel) : null,
      item.current ? stableJson(item.current) : null,
      stableJson({ reason: item.reason || null, lineageId: item.lineageId || null }),
      await sha256Hex(stableJson([item.operation, item.sheetName, item.rowNumber, item.lineageId, item.excelHash])),
      item.error || null
    ]);
  }
  statements.push(...multiRowInsert(db, 'ledger_import_rows', [
    'operation_id', 'import_id', 'sheet_name', 'row_number', 'operation',
    'event_id', 'base_version', 'base_json', 'excel_json', 'current_json',
    'diff_json', 'row_hash', 'error_text',
  ], importRows));
  await db.batch(statements);
  return preview;
}

async function confirmImport(db, body, actor) {
  const importId = String(body.importId || '');
  const expectedRevision = Number(body.expectedLedgerRevision);
  const selected = new Set((Array.isArray(body.selectedOperationIds) ? body.selectedOperationIds : []).map(String));
  if (!selected.size) throw new LedgerHttpError(422, '請至少選擇一筆 CREATE/UPDATE');
  if (selected.size > 120) throw new LedgerHttpError(413, '單次最多確認 120 筆；請分批匯入');
  const batch = await dbFirst(db, 'SELECT * FROM ledger_imports WHERE import_id = ?', [importId]);
  if (!batch) throw new LedgerHttpError(404, '匯入預覽不存在');
  if (batch.status !== 'PREVIEWED') throw new LedgerHttpError(409, '此匯入已處理');
  const state = await portfolioRow(db, batch.portfolio_id);
  if (Number(state.ledger_revision) !== expectedRevision || Number(state.ledger_revision) !== Number(batch.base_ledger_revision)) {
    await db.prepare("UPDATE ledger_imports SET status = 'STALE' WHERE import_id = ? AND status = 'PREVIEWED'").bind(importId).run();
    throw new LedgerHttpError(409, '賬本版本已改變，必須重新上傳預覽');
  }
  const rows = [];
  for (const ids of chunked([...selected], 99)) {
    rows.push(...await dbAll(db, `
      SELECT * FROM ledger_import_rows
      WHERE import_id = ? AND operation_id IN (${ids.map(() => '?').join(',')})
    `, [importId, ...ids]));
  }
  if (rows.length !== selected.size) throw new LedgerHttpError(400, '包含無效 operationId');
  if (rows.some(row => !['CREATE', 'UPDATE'].includes(row.operation))) {
    throw new LedgerHttpError(422, '只能確認 CREATE/UPDATE；衝突需先解決');
  }
  const timestamp = now();
  const guardId = makeId('ltg');
  const guard = db.prepare(`
    INSERT INTO ledger_transaction_guards (
      guard_id, pending_id, expected_pending_version,
      portfolio_id, expected_ledger_revision, created_at
    ) VALUES (
      ?,
      (SELECT import_id FROM ledger_imports WHERE import_id = ? AND status = 'PREVIEWED'),
      1,
      (SELECT portfolio_id FROM ledger_portfolios WHERE portfolio_id = ? AND ledger_revision = ?),
      ?, ?
    )
  `).bind(guardId, importId, batch.portfolio_id, expectedRevision, expectedRevision, timestamp);
  const statements = [guard];
  const pendingIds = [];
  const eventIds = rows.map(row => row.event_id).filter(Boolean);
  const currentEvents = [];
  for (const ids of chunked(eventIds, 100)) {
    currentEvents.push(...await dbAll(db, `
      SELECT * FROM ledger_events WHERE event_id IN (${ids.map(() => '?').join(',')})
    `, ids));
  }
  const currentById = new Map(currentEvents.map(row => [row.event_id, row]));
  const pendingRows = [];
  const auditRows = [];
  for (const row of rows) {
    const event = canonicalEvent(parseJson(row.excel_json, {}), batch.portfolio_id);
    event.status = 'pending';
    const current = row.event_id ? currentById.get(row.event_id) || null : null;
    const pendingId = makeId('lpd');
    pendingIds.push(pendingId);
    const lineageId = current && current.lineage_id || null;
    const idempotencyKey = 'excel:' + importId + ':' + row.operation_id;
    pendingRows.push([
      pendingId, batch.portfolio_id, event.event_type, event.trade_date, stableJson(event),
      'PENDING', 1, 'EXCEL',
      batch.file_name, idempotencyKey, importId, lineageId,
      current && current.event_id || null, current && Number(current.event_version) || null,
      actor, actor, timestamp, timestamp
    ]);
    auditRows.push([
      makeId('lau'), batch.portfolio_id, 'ADMIN', actor,
      'EXCEL_STAGED_PENDING', 'PENDING', pendingId,
      current && current.payload_json || null, stableJson(event),
      stableJson({ importId, operationId: row.operation_id, operation: row.operation }), timestamp
    ]);
  }
  statements.push(...multiRowInsert(db, 'ledger_pending', [
    'pending_id', 'portfolio_id', 'event_type', 'trade_date', 'payload_json',
    'status', 'version', 'source', 'source_ref', 'idempotency_key', 'import_id',
    'lineage_id', 'base_event_id', 'base_event_version',
    'created_by', 'updated_by', 'created_at', 'updated_at',
  ], pendingRows));
  statements.push(...multiRowInsert(db, 'ledger_audit_log', [
    'audit_id', 'portfolio_id', 'actor_type', 'actor_ref', 'action',
    'target_type', 'target_id', 'before_json', 'after_json', 'metadata_json', 'created_at',
  ], auditRows));
  statements.push(db.prepare(`
    UPDATE ledger_imports SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?
    WHERE import_id = ? AND status = 'PREVIEWED'
  `).bind(actor, timestamp, importId));
  statements.push(db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId));
  try { await db.batch(statements); } catch (error) {
    throw new LedgerHttpError(409, '匯入確認時賬本已改變，請重新預覽');
  }
  return { ok: true, importId, staged: pendingIds.length, pendingIds, ledgerRevision: expectedRevision };
}

async function ingestSourceRecord(db, body, actor) {
  const portfolio = portfolioId(body.portfolio);
  const sourceSystem = String(body.sourceSystem || '').trim().slice(0, 100);
  const sourceAccount = String(body.sourceAccount || '').trim().slice(0, 100);
  const sourceEventId = String(body.sourceEventId || '').trim().slice(0, 200);
  if (!sourceSystem || !sourceEventId) throw new LedgerHttpError(422, 'sourceSystem/sourceEventId 不能為空');
  const event = canonicalEvent(body.event, portfolio);
  const rawPayload = body.rawPayload && typeof body.rawPayload === 'object' ? body.rawPayload : body.event;
  const contentSha = await sha256Hex(stableJson(rawPayload));
  const existing = await dbFirst(db, `
    SELECT * FROM ledger_source_records
    WHERE portfolio_id = ? AND source_system = ? AND source_account = ? AND source_event_id = ?
  `, [portfolio, sourceSystem, sourceAccount, sourceEventId]);
  if (existing) {
    if (existing.content_sha256 !== contentSha) {
      throw new LedgerHttpError(409, '同一來源事件 ID 收到不同內容，已停止自動覆蓋', {
        code: 'SOURCE_PAYLOAD_CONFLICT',
        sourceRecordId: existing.source_record_id,
        sourceSystem,
        sourceAccount,
        sourceEventId,
      });
    }
    let pending = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE source_record_id = ?', [existing.source_record_id]);
    if (!pending) {
      const repaired = await createPending(db, portfolio, event, actor || 'automation', {
        source: 'AUTOMATION', sourceRecordId: existing.source_record_id,
        sourceRef: sourceSystem + ':' + sourceEventId,
        idempotencyKey: sourceSystem + ':' + sourceAccount + ':' + sourceEventId,
      });
      pending = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [repaired.item.pendingId]);
    }
    return { ok: true, duplicate: true, sourceRecordId: existing.source_record_id, pending: pendingItem(pending) };
  }
  const sourceRecordId = makeId('lsr');
  const pendingId = makeId('lpd');
  const auditId = makeId('lau');
  const timestamp = now();
  const actorRef = actor || 'automation';
  const sourceRef = sourceSystem + ':' + sourceEventId;
  const idempotencyKey = sourceSystem + ':' + sourceAccount + ':' + sourceEventId;
  event.status = 'pending';
  const eventPayload = stableJson(event);
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO ledger_source_records (
          source_record_id, portfolio_id, source_system, source_account,
          source_event_id, event_type, trade_date, payload_json,
          evidence_json, content_sha256, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sourceRecordId, portfolio, sourceSystem, sourceAccount, sourceEventId,
        event.event_type, event.trade_date, stableJson(rawPayload),
        body.evidence ? stableJson(body.evidence) : null, contentSha, timestamp
      ),
      db.prepare(`
        INSERT INTO ledger_pending (
          pending_id, portfolio_id, event_type, trade_date, payload_json,
          status, version, source, source_record_id, source_ref,
          idempotency_key, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', 1, 'AUTOMATION', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        pendingId, portfolio, event.event_type, event.trade_date, eventPayload,
        sourceRecordId, sourceRef, idempotencyKey,
        actorRef, actorRef, timestamp, timestamp
      ),
      db.prepare(`
        INSERT INTO ledger_audit_log (
          audit_id, portfolio_id, actor_type, actor_ref, action,
          target_type, target_id, before_json, after_json, metadata_json, created_at
        ) VALUES (?, ?, 'SYSTEM', ?, 'SOURCE_PENDING_CREATED', 'PENDING', ?, NULL, ?, ?, ?)
      `).bind(
        auditId, portfolio, actorRef, pendingId, eventPayload,
        stableJson({ sourceRecordId, sourceSystem, sourceAccount, sourceEventId }), timestamp
      ),
    ]);
  } catch (error) {
    const raced = await dbFirst(db, `
      SELECT * FROM ledger_source_records
      WHERE portfolio_id = ? AND source_system = ? AND source_account = ? AND source_event_id = ?
    `, [portfolio, sourceSystem, sourceAccount, sourceEventId]);
    if (!raced) throw error;
    const pending = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE source_record_id = ?', [raced.source_record_id]);
    return { ok: true, duplicate: true, sourceRecordId: raced.source_record_id, pending: pendingItem(pending) };
  }
  const created = await dbFirst(db, 'SELECT * FROM ledger_pending WHERE pending_id = ?', [pendingId]);
  return { ok: true, duplicate: false, sourceRecordId, pending: pendingItem(created) };
}

async function previewLegacyMigration(db, body, actor) {
  const portfolio = portfolioId(body.portfolio || body.portfolio_id);
  const sourceWorkbookSha256 = String(body.sourceWorkbookSha256 || body.source_workbook_sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceWorkbookSha256)) {
    throw new LedgerHttpError(400, 'sourceWorkbookSha256 無效');
  }
  const existingImport = await dbFirst(db, `
    SELECT * FROM ledger_imports WHERE portfolio_id = ? AND upload_sha256 = ?
  `, [portfolio, sourceWorkbookSha256]);
  if (existingImport && ['PREVIEWED', 'CONFIRMED'].includes(existingImport.status)) {
    return {
      ...parseJson(existingImport.preview_json, {}),
      importId: existingImport.import_id,
      duplicateUpload: true,
      importStatus: existingImport.status,
    };
  }
  const state = await portfolioRow(db, portfolio);
  if (Number(state.ledger_revision) !== 0) {
    throw new LedgerHttpError(409, '此基金已有確認事件，不能再執行首次歷史遷移');
  }
  const existingCount = await dbFirst(db, 'SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = ?', [portfolio]);
  if (Number(existingCount && existingCount.count || 0) !== 0) {
    throw new LedgerHttpError(409, '此基金已有歷史事件');
  }
  if (existingImport) {
    await db.prepare('DELETE FROM ledger_imports WHERE import_id = ?').bind(existingImport.import_id).run();
  }
  const rawEvents = Array.isArray(body.events) ? body.events : null;
  if (!rawEvents || !rawEvents.length) throw new LedgerHttpError(422, '遷移 events 為空');
  if (rawEvents.length > 120) throw new LedgerHttpError(413, '單一基金歷史事件不能超過 120 筆');
  const rawNavRows = body.historicalNavRows ?? body.historical_nav_rows ?? [];
  if (!Array.isArray(rawNavRows)) throw new LedgerHttpError(422, 'historical_nav_rows 必須是陣列');
  if (rawNavRows.length > MAX_NAV_SEED_ROWS) throw new LedgerHttpError(413, '歷史 NAV 行數過多');
  const historicalNavRows = rawNavRows.map((row, index) => canonicalNavSeedRow({
    ...row,
    source_workbook_sha256: sourceWorkbookSha256,
  }, portfolio, index)).sort((left, right) => left.date.localeCompare(right.date));
  const navDates = new Set();
  for (const row of historicalNavRows) {
    if (navDates.has(row.date)) throw new LedgerHttpError(422, `歷史 NAV 日期重複：${row.date}`);
    navDates.add(row.date);
  }
  const rawPriceRows = body.historicalPriceRows ?? body.historical_price_rows ?? [];
  if (!Array.isArray(rawPriceRows)) throw new LedgerHttpError(422, 'historical_price_rows 必須是陣列');
  if (rawPriceRows.length > MAX_PRICE_SEED_ROWS) throw new LedgerHttpError(413, '歷史價格種子行數過多');
  const historicalPriceRows = rawPriceRows.map((row, index) =>
    canonicalPriceSeedRow(row, portfolio, index, sourceWorkbookSha256));
  const priceKeys = new Set();
  for (const row of historicalPriceRows) {
    const key = `${row.ticker}:${row.date}`;
    if (priceKeys.has(key)) throw new LedgerHttpError(422, `歷史價格重複：${key}`);
    priceKeys.add(key);
  }
  const ids = new Set();
  const canonical = rawEvents.map((source, index) => {
    const raw = source && source.payload && typeof source.payload === 'object'
      ? {
          ...source.payload,
          event_id: source.event_id,
          event_type: source.event_type,
          status: 'confirmed',
          sequence: source.sequence_no ?? index,
        }
      : source;
    const event = canonicalEvent(raw, portfolio);
    const eventId = String(source.event_id || event.event_id || '').trim();
    if (!/^legacy_[a-z]+_[a-f0-9]{16,64}$/.test(eventId)) {
      throw new LedgerHttpError(422, `第 ${index + 1} 筆缺少 deterministic legacy event_id`);
    }
    if (ids.has(eventId)) throw new LedgerHttpError(422, `重複 event_id：${eventId}`);
    ids.add(eventId);
    event.event_id = eventId;
    event.source = 'MIGRATION';
    event.source_ref = String(source.source_ref || `${source.source_sheet || ''}:${source.source_row || index + 1}`);
    event.tax_status = source.tax_status || event.tax_status || 'UNKNOWN_LEGACY';
    return event;
  });
  const previewItems = canonical.map((event, index) => ({
    eventId: event.event_id,
    lineageId: event.event_id,
    eventVersion: 1,
    portfolio,
    ledgerRevision: index + 1,
    eventType: upper(event.event_type || event.type),
    tradeDate: event.trade_date || event.date,
    sequenceNo: Number(event.sequence_no ?? event.sequence ?? CASH_PRIORITY[upper(event.event_type || event.type)] ?? 99),
    currency: PORTFOLIOS[portfolio].currency,
    event,
  }));
  const projection = replay(previewItems, portfolio, {
    corporateActionPrices: historicalPriceRows.map(row => ({
      ticker: row.ticker,
      date: row.date,
      price: row.priceMicros / 1_000_000,
    })),
  });
  const hashes = new Map();
  const exactDuplicates = [];
  for (const item of previewItems) {
    const hash = await canonicalHash(item.event);
    if (hashes.has(hash)) exactDuplicates.push({ firstEventId: hashes.get(hash), eventId: item.eventId });
    else hashes.set(hash, item.eventId);
  }
  const navSeedHash = await sha256Hex(stableJson(historicalNavRows));
  const priceSeedHash = await sha256Hex(stableJson(historicalPriceRows));
  const migrationHash = await sha256Hex(stableJson({
    portfolio, sourceWorkbookSha256, canonical, historicalNavRows, historicalPriceRows,
  }));
  const importId = makeId('lmg');
  const warnings = projectionProblems(projection).filter(item => problemSeverity(item) === 'WARNING');
  const unknownTaxEvents = canonical.filter(event => event.tax_status === 'UNKNOWN_LEGACY').length;
  const preview = {
    ok: true,
    migration: true,
    importId,
    migrationHash,
    portfolio,
    currency: PORTFOLIOS[portfolio].currency,
    sourceWorkbookSha256,
    eventCount: canonical.length,
    historicalNavRowCount: historicalNavRows.length,
    historicalNavDateRange: historicalNavRows.length
      ? [historicalNavRows[0].date, historicalNavRows[historicalNavRows.length - 1].date]
      : null,
    navSeedHash,
    historicalPriceRowCount: historicalPriceRows.length,
    priceSeedHash,
    exactDuplicates,
    unknownTaxEvents,
    lowestCashMinor: lowestCashMinor(projection),
    warnings,
    projection,
    canonicalEvents: canonical,
    historicalNavRows,
    historicalPriceRows,
  };
  await db.prepare(`
    INSERT INTO ledger_imports (
      import_id, portfolio_id, file_name, upload_sha256, export_id,
      base_ledger_revision, status, preview_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, NULL, 0, 'PREVIEWED', ?, ?, ?)
  `).bind(
    importId, portfolio, `legacy-${portfolio}-${sourceWorkbookSha256.slice(0, 12)}.json`,
    sourceWorkbookSha256, stableJson(preview), actor, now()
  ).run();
  return preview;
}

async function confirmLegacyMigration(db, env, body, actor) {
  const importId = String(body.importId || '');
  const migrationHash = String(body.migrationHash || '');
  const batch = await dbFirst(db, 'SELECT * FROM ledger_imports WHERE import_id = ?', [importId]);
  if (!batch) throw new LedgerHttpError(404, '歷史遷移預覽不存在');
  if (batch.status !== 'PREVIEWED') throw new LedgerHttpError(409, '此歷史遷移已處理');
  const preview = parseJson(batch.preview_json, {});
  if (!preview.migration || preview.migrationHash !== migrationHash) {
    throw new LedgerHttpError(409, '歷史遷移 hash 不匹配，請重新預覽');
  }
  const portfolio = batch.portfolio_id;
  const acknowledgement = body.acknowledgement && typeof body.acknowledgement === 'object'
    ? body.acknowledgement : {};
  const expectedPhrase = `CONFIRM LEGACY ${portfolio.toUpperCase()}`;
  if (String(acknowledgement.phrase || '').trim().toUpperCase() !== expectedPhrase) {
    throw new LedgerHttpError(422, `請輸入 ${expectedPhrase}`);
  }
  if (preview.lowestCashMinor < 0 && acknowledgement.negativeCash !== true) {
    throw new LedgerHttpError(422, '必須明確確認保留歷史負現金');
  }
  if (preview.exactDuplicates.length && acknowledgement.duplicates !== true) {
    throw new LedgerHttpError(422, '必須明確確認保留完全重複事件');
  }
  if (preview.unknownTaxEvents && acknowledgement.unknownTax !== true) {
    throw new LedgerHttpError(422, '必須明確確認歷史稅項維持 UNKNOWN_LEGACY');
  }
  if (preview.historicalNavRowCount && acknowledgement.historicalNav !== true) {
    throw new LedgerHttpError(422, '必須明確確認 NAV Statement 僅作為只讀歷史估值種子');
  }
  if (preview.historicalPriceRowCount && acknowledgement.historicalPrices !== true) {
    throw new LedgerHttpError(422, '必須明確確認 Asset Position 僅作為只讀價格種子');
  }
  const state = await portfolioRow(db, portfolio);
  if (Number(state.ledger_revision) !== 0) throw new LedgerHttpError(409, '賬本已改變，不能執行首次遷移');
  const canonical = preview.canonicalEvents;
  const timestamp = now();
  const guardId = makeId('ltg');
  const guard = db.prepare(`
    INSERT INTO ledger_transaction_guards (
      guard_id, pending_id, expected_pending_version,
      portfolio_id, expected_ledger_revision, created_at
    ) VALUES (
      ?,
      (SELECT import_id FROM ledger_imports WHERE import_id = ? AND status = 'PREVIEWED'),
      1,
      (SELECT portfolio_id FROM ledger_portfolios WHERE portfolio_id = ? AND ledger_revision = 0),
      0, ?
    )
  `).bind(guardId, importId, portfolio, timestamp);
  const eventRows = canonical.map((event, index) => {
    const eventId = event.event_id;
    const taxUnknown = event.tax_status === 'UNKNOWN_LEGACY';
    return {
      event_id: eventId,
      lineage_id: eventId,
      event_version: 1,
      portfolio_id: portfolio,
      ledger_revision: index + 1,
      event_type: upper(event.event_type || event.type),
      trade_date: event.trade_date || event.date,
      sequence_no: Number(event.sequence_no ?? event.sequence ?? CASH_PRIORITY[upper(event.event_type || event.type)] ?? 99),
      currency: PORTFOLIOS[portfolio].currency,
      payload_json: stableJson(event),
      gross_amount_minor: taxUnknown ? null : moneyMinor(event, 'gross_amount_minor'),
      tax_amount_minor: taxUnknown ? null : moneyMinor(event, 'tax_amount_minor'),
      fee_amount_minor: taxUnknown ? null : moneyMinor(event, 'fee_amount_minor'),
      net_cash_minor: moneyMinor(event, 'net_cash_minor'),
      source: 'MIGRATION',
      source_ref: event.source_ref || null,
      idempotency_key: `migration:${preview.sourceWorkbookSha256}:${eventId}`,
      confirmed_by: actor,
      confirm_reason: 'Legacy migration sign-off',
      confirmed_at: timestamp,
    };
  });
  const navRows = (preview.historicalNavRows || []).map(row => ({
    ...row,
    portfolio_id: portfolio,
    ledger_revision: canonical.length,
    calculated_at: timestamp,
    source_workbook_sha256: preview.sourceWorkbookSha256,
    valuation_json: stableJson(row.valuation || {}),
    warnings_json: stableJson(row.warnings || []),
  }));
  const priceRows = (preview.historicalPriceRows || []).map(row => ({
    ...row,
    portfolio_id: portfolio,
    ledger_revision: canonical.length,
    source_workbook_sha256: preview.sourceWorkbookSha256,
    valuation_json: stableJson(row.valuation || {}),
    observed_at: timestamp,
  }));
  const statements = [
    guard,
    db.prepare(`
      INSERT INTO ledger_events (
        event_id, lineage_id, event_version, portfolio_id, ledger_revision,
        event_type, trade_date, sequence_no, currency, payload_json,
        gross_amount_minor, tax_amount_minor, fee_amount_minor, net_cash_minor,
        source, source_ref, idempotency_key, supersedes_event_id,
        reversal_of_event_id, pending_id, confirmed_by, confirm_reason, confirmed_at
      )
      SELECT
        json_extract(value, '$.event_id'), json_extract(value, '$.lineage_id'),
        json_extract(value, '$.event_version'), json_extract(value, '$.portfolio_id'),
        json_extract(value, '$.ledger_revision'), json_extract(value, '$.event_type'),
        json_extract(value, '$.trade_date'), json_extract(value, '$.sequence_no'),
        json_extract(value, '$.currency'), json_extract(value, '$.payload_json'),
        json_extract(value, '$.gross_amount_minor'), json_extract(value, '$.tax_amount_minor'),
        json_extract(value, '$.fee_amount_minor'), json_extract(value, '$.net_cash_minor'),
        json_extract(value, '$.source'), json_extract(value, '$.source_ref'),
        json_extract(value, '$.idempotency_key'), NULL, NULL, NULL,
        json_extract(value, '$.confirmed_by'), json_extract(value, '$.confirm_reason'),
        json_extract(value, '$.confirmed_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(eventRows)),
  ];
  if (navRows.length) {
    statements.push(db.prepare(`
      INSERT INTO ledger_nav_snapshots (
        portfolio_id, nav_date, ledger_revision, cash_minor, market_value_minor,
        total_assets_minor, liability_minor, liability_asset_ratio_micros,
        net_value_minor, units_micros, unit_nav_micros,
        fund_action_adjustment_minor, source, source_ref,
        source_workbook_sha256, source_row, valuation_json, warnings_json, calculated_at
      )
      SELECT
        json_extract(value, '$.portfolio_id'), json_extract(value, '$.date'),
        json_extract(value, '$.ledger_revision'), json_extract(value, '$.cashMinor'),
        json_extract(value, '$.marketValueMinor'), json_extract(value, '$.totalAssetsMinor'),
        json_extract(value, '$.liabilityMinor'), json_extract(value, '$.liabilityAssetRatioMicros'),
        json_extract(value, '$.netValueMinor'), json_extract(value, '$.unitsMicros'),
        json_extract(value, '$.unitNavMicros'), json_extract(value, '$.fundActionAdjustmentMinor'),
        json_extract(value, '$.source'), json_extract(value, '$.sourceRef'),
        json_extract(value, '$.source_workbook_sha256'), json_extract(value, '$.sourceRow'),
        json_extract(value, '$.valuation_json'), json_extract(value, '$.warnings_json'),
        json_extract(value, '$.calculated_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(navRows)));
  }
  if (priceRows.length) {
    statements.push(db.prepare(`
      INSERT INTO ledger_prices (
        portfolio_id, ticker, price_date, ledger_revision, price_micros,
        currency, source, source_ref, source_workbook_sha256,
        source_row, valuation_json, observed_at
      )
      SELECT
        json_extract(value, '$.portfolio_id'), json_extract(value, '$.ticker'),
        json_extract(value, '$.date'), json_extract(value, '$.ledger_revision'),
        json_extract(value, '$.priceMicros'), json_extract(value, '$.currency'),
        json_extract(value, '$.source'), json_extract(value, '$.sourceRef'),
        json_extract(value, '$.source_workbook_sha256'), json_extract(value, '$.sourceRow'),
        json_extract(value, '$.valuation_json'), json_extract(value, '$.observed_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(priceRows)));
  }
  statements.push(
    db.prepare('UPDATE ledger_portfolios SET ledger_revision = ?, updated_at = ? WHERE portfolio_id = ? AND ledger_revision = 0')
      .bind(canonical.length, timestamp, portfolio),
    db.prepare(`
      UPDATE ledger_imports SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?
      WHERE import_id = ? AND status = 'PREVIEWED'
    `).bind(actor, timestamp, importId),
    db.prepare(`
      INSERT INTO ledger_audit_log (
        audit_id, portfolio_id, actor_type, actor_ref, action,
        target_type, target_id, before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, 'MIGRATION', ?, 'LEGACY_MIGRATION_CONFIRMED', 'IMPORT', ?, NULL, ?, ?, ?)
    `).bind(
      makeId('lau'), portfolio, actor, importId,
      stableJson({ eventCount: canonical.length, ledgerRevision: canonical.length }),
      stableJson({
        migrationHash, sourceWorkbookSha256: preview.sourceWorkbookSha256,
        acknowledgement, exactDuplicates: preview.exactDuplicates,
        lowestCashMinor: preview.lowestCashMinor, unknownTaxEvents: preview.unknownTaxEvents,
        historicalNavRowCount: preview.historicalNavRowCount,
        historicalNavDateRange: preview.historicalNavDateRange,
        navSeedHash: preview.navSeedHash,
        historicalPriceRowCount: preview.historicalPriceRowCount,
        priceSeedHash: preview.priceSeedHash,
      }), timestamp
    ),
    ...['REBUILD_KV', 'REBUILD_EXCEL', 'RECALC_NAV'].map(kind => db.prepare(`
      INSERT INTO ledger_outbox (
        outbox_id, portfolio_id, ledger_revision, kind, payload_json,
        status, attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)
    `).bind(
      makeId('lob'), portfolio, canonical.length, kind,
      stableJson({ importId, migrationHash, affectedFrom: canonical[0] && canonical[0].date }),
      timestamp, timestamp
    )),
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  );
  try { await db.batch(statements); } catch (error) {
    throw new LedgerHttpError(409, '歷史遷移提交失敗或賬本已改變');
  }
  await materializeLedgerKv(env, portfolio).catch(error =>
    console.error('legacy_migration_kv_materialize_failed', portfolio, error));
  return {
    ok: true, portfolio, eventCount: canonical.length,
    historicalNavRowCount: navRows.length,
    historicalPriceRowCount: priceRows.length,
    ledgerRevision: canonical.length, migrationHash,
  };
}

function projectionNumber(value, minorValue) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (Number.isFinite(Number(minorValue))) return Number(minorValue) / 100;
  return 0;
}
function projectionPositions(projection) {
  const raw = projection && (projection.positions || projection.asset_positions || projection.holdings) || [];
  const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
  return rows.filter(Boolean).map(row => ({
    t: String(row.ticker || row.t || row.symbol || '').slice(0, 16),
    n: String(row.name || row.n || row.ticker || row.t || '').slice(0, 100),
    q: Number(row.quantity ?? row.qty ?? row.q ?? row.shares ?? 0),
    p: Number(row.price ?? row.p ?? row.reference_price ?? 0),
    mv: projectionNumber(row.market_value ?? row.mv, row.market_value_minor),
    netCost: projectionNumber(row.net_cost ?? row.netCost, row.net_cost_minor),
    buyCost: projectionNumber(row.total_buy_cost ?? row.buyCost, row.total_buy_cost_minor),
    sellProceeds: projectionNumber(row.sell_proceeds ?? row.sellProceeds, row.sell_proceeds_minor),
    dividend: projectionNumber(row.dividend_income ?? row.dividend, row.dividend_income_minor),
    pnl: projectionNumber(row.total_pnl ?? row.pnl, row.total_pnl_minor),
    priceDate: row.price_date || null,
    priceSource: row.price_source || null,
  })).filter(row => row.t && row.q > 0.001);
}
function finalCash(projection) {
  const chain = projection && (projection.cash_chain || projection.cashChain) || [];
  const last = Array.isArray(chain) && chain.length ? chain[chain.length - 1] : null;
  const explicitMinor = projection
    ? (projection.cash_minor ?? projection.cash_balance_minor)
    : null;
  const chainMinor = last
    ? (last.cash_after_minor ?? last.after_minor ?? last.balance_minor)
    : null;
  return projectionNumber(
    projection && (projection.cash ?? projection.cash_balance),
    explicitMinor ?? chainMinor
  );
}
function finalLiability(projection) {
  const liability = projection && projection.liability;
  const value = projection
    ? ((liability && liability.balance) ?? projection.liability_balance ?? liability)
    : null;
  const minor = projection
    ? ((liability && liability.balance_minor) ?? projection.liability_balance_minor)
    : null;
  return projectionNumber(typeof value === 'object' ? null : value, minor);
}
function finalUnits(projection) {
  const units = projection && projection.units;
  if (typeof units === 'number') return units;
  if (units && typeof units === 'object') {
    return Number(units.total_units ?? units.total ?? units.balance ?? units.total_units_decimal ?? 0);
  }
  return Number(projection && (projection.total_units ?? projection.units_total) || 0);
}

async function requeueLatestKv(db, portfolio, ledgerRevision, reason) {
  const timestamp = now();
  await db.prepare(`
    INSERT INTO ledger_outbox (
      outbox_id, portfolio_id, ledger_revision, kind, payload_json,
      status, attempts, available_at, last_error, created_at, processed_at
    ) VALUES (?, ?, ?, 'REBUILD_KV', ?, 'PENDING', 0, ?, ?, ?, NULL)
    ON CONFLICT(portfolio_id, ledger_revision, kind) DO UPDATE SET
      status = 'PENDING', attempts = 0, available_at = excluded.available_at,
      last_error = excluded.last_error, processed_at = NULL
  `).bind(
    makeId('lob'), portfolio, ledgerRevision,
    stableJson({ reason: 'revision-race-recovery' }), timestamp,
    String(reason || 'ledger revision changed during KV publication').slice(0, 1000), timestamp,
  ).run();
}

export async function materializeLedgerKv(env, requestedPortfolio, options = {}) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const state = await portfolioRow(db, portfolio);
  const capturedRevision = Number(state.ledger_revision);
  const [events, navRows, priceRows, priceHistory] = await Promise.all([
    activeEvents(db, portfolio, capturedRevision),
    loadNavSnapshots(db, portfolio, capturedRevision),
    loadLatestPrices(db, portfolio, capturedRevision),
    loadPriceHistory(db, portfolio, capturedRevision),
  ]);
  const projection = enrichProjectionPrices(replay(events, portfolio, {
    corporateActionPrices: priceHistory,
  }), priceRows);
  const positions = projectionPositions(projection);
  const cash = finalCash(projection);
  const liability = finalLiability(projection);
  const units = finalUnits(projection);
  const sourceDate = events.reduce((date, item) => item.tradeDate > date ? item.tradeDate : date, '');
  const marketValue = positions.reduce((sum, row) => sum + Number(row.mv || row.q * row.p || 0), 0);
  const totalAssets = cash + marketValue;
  const netValue = totalAssets - liability;
  const oldRaw = await env.YC_KV.get('ledger:' + portfolio);
  const old = oldRaw ? parseJson(oldRaw, {}) : {};
  const history = historyFromNav(navRows, events);
  const latestNav = navRows.length ? navRows[navRows.length - 1] : null;
  const fundActionAdjustments = fundActionAdjustmentByDate(events);
  const fundDividends = fundDividendByDate(events);
  const corporateActionPricePending = projectionProblems(projection)
    .filter(problem => problem && problem.code === 'CORPORATE_ACTION_PRICE_FALLBACK')
    .map(problem => String(problem.date || problem.action_date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const ledger = {
    market: portfolio,
    portfolio,
    currency: PORTFOLIOS[portfolio].currency,
    positions,
    confirmedEvents: engineEvents(events),
    priceHistory,
    sourceHoldings: positions.map(row => ({
      t: row.t, n: row.n, q: row.q, price: row.p,
      marketValue: row.mv || row.q * row.p, date: row.priceDate || sourceDate,
      buyCost: row.buyCost, sellProceeds: row.sellProceeds,
      dividend: row.dividend, netCost: row.netCost, pnl: row.pnl,
    })),
    cash,
    liability,
    units,
    sourceDate,
    lastDate: latestNav && latestNav.date || sourceDate,
    baseMarketValue: marketValue,
    baseTotalAssets: totalAssets,
    baseNetValue: netValue,
    baseMV: netValue,
    lastUnitNav: latestNav && Number(latestNav.nav || latestNav.unitNav)
      || (units > 0 ? netValue / units : 0),
    history,
    navRows,
    fundActionAdjustments,
    fundDividends,
    navRecalculationRequired: navRows.filter(row => row.recalculationRequired).map(row => row.date),
    corporateActionPricePending: [...new Set(corporateActionPricePending)],
    sourceMetrics: old.sourceMetrics || {},
    snap: old.snap || null,
    fingerprint: await sha256Hex(stableJson({
      ledgerRevision: capturedRevision,
      positions: positions.map(row => [row.t, row.q]), cash, liability, units,
    })),
    ledgerRevision: capturedRevision,
    source: 'd1-confirmed-event-ledger',
    savedBy: 'ledger-outbox',
    savedAt: new Date().toISOString(),
  };
  const beforeWrite = await portfolioRow(db, portfolio);
  if (Number(beforeWrite.ledger_revision) !== capturedRevision) {
    const latestRevision = Number(beforeWrite.ledger_revision);
    await requeueLatestKv(db, portfolio, latestRevision, 'revision changed before KV write');
    if (Number(options.raceRetry || 0) < 2) {
      return materializeLedgerKv(env, portfolio, { raceRetry: Number(options.raceRetry || 0) + 1 });
    }
    throw new Error('ledger revision kept changing before KV publication');
  }
  await env.YC_KV.put('ledger:' + portfolio, JSON.stringify(ledger));
  const afterWrite = await portfolioRow(db, portfolio);
  if (Number(afterWrite.ledger_revision) === capturedRevision) {
    await db.prepare(`
      UPDATE ledger_outbox SET status = 'DONE', attempts = attempts + 1,
        processed_at = ?, last_error = NULL
      WHERE portfolio_id = ? AND kind = 'REBUILD_KV'
        AND ledger_revision <= ? AND status IN ('PENDING', 'FAILED')
    `).bind(now(), portfolio, capturedRevision).run();
  } else {
    const latestRevision = Number(afterWrite.ledger_revision);
    await requeueLatestKv(db, portfolio, latestRevision, 'revision changed during KV write');
    if (Number(options.raceRetry || 0) < 2) {
      return materializeLedgerKv(env, portfolio, { raceRetry: Number(options.raceRetry || 0) + 1 });
    }
    throw new Error('ledger revision kept changing during KV publication');
  }
  return ledger;
}

export async function drainLedgerOutbox(env, options = {}) {
  const db = ledgerDb(env);
  const portfolio = options.portfolio ? portfolioId(options.portfolio) : null;
  const readyAt = now();
  const rows = await dbAll(db, `
    SELECT o.*,
      (SELECT MIN(json_extract(p.payload_json, '$.affectedFrom'))
       FROM ledger_outbox p
       WHERE p.portfolio_id = o.portfolio_id AND p.kind = o.kind
         AND p.status IN ('PENDING', 'FAILED')) AS affected_from_min
    FROM ledger_outbox o
    WHERE o.status IN ('PENDING', 'FAILED') AND o.available_at <= ?
      ${portfolio ? 'AND o.portfolio_id = ?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM ledger_outbox newer
        WHERE newer.portfolio_id = o.portfolio_id AND newer.kind = o.kind
          AND newer.status IN ('PENDING', 'FAILED') AND newer.available_at <= ?
          AND newer.ledger_revision > o.ledger_revision
      )
    ORDER BY o.created_at,
      CASE o.kind WHEN 'REBUILD_KV' THEN 0 WHEN 'RECALC_NAV' THEN 1 ELSE 2 END
    LIMIT 5
  `, portfolio ? [readyAt, portfolio, readyAt] : [readyAt, readyAt]);
  const results = [];
  for (const row of rows) {
    try {
      const fresh = await dbFirst(db, 'SELECT status, available_at FROM ledger_outbox WHERE outbox_id = ?', [row.outbox_id]);
      if (!fresh || !['PENDING', 'FAILED'].includes(fresh.status) || Number(fresh.available_at) > now()) continue;
      if (row.kind === 'REBUILD_KV') await materializeLedgerKv(env, row.portfolio_id);
      else if (row.kind === 'RECALC_NAV' && typeof options.refreshPortfolio === 'function') {
        const dependency = await dbFirst(db, `
          SELECT COUNT(*) AS count FROM ledger_outbox
          WHERE portfolio_id = ? AND kind = 'REBUILD_KV'
            AND ledger_revision <= ? AND status != 'DONE'
        `, [row.portfolio_id, Number(row.ledger_revision)]);
        if (Number(dependency && dependency.count || 0) > 0) continue;
        const refresh = await options.refreshPortfolio(env, row.portfolio_id, {
          ledgerRevision: Number(row.ledger_revision),
          affectedFrom: row.affected_from_min || parseJson(row.payload_json, {}).affectedFrom || null,
        });
        if (refresh && (refresh.skip || refresh.fallback === true)) {
          throw new Error('NAV recalculation did not complete: ' + (refresh.skip || refresh.reason || 'fallback'));
        }
        await db.prepare(`
          UPDATE ledger_outbox SET status = 'DONE', attempts = attempts + 1,
            processed_at = ?, last_error = NULL
          WHERE portfolio_id = ? AND kind = 'RECALC_NAV'
            AND ledger_revision <= ? AND status IN ('PENDING', 'FAILED')
        `).bind(now(), row.portfolio_id, Number(row.ledger_revision)).run();
      } else if (row.kind === 'REBUILD_EXCEL') {
        const dependency = await dbFirst(db, `
          SELECT COUNT(*) AS count FROM ledger_outbox
          WHERE portfolio_id = ? AND kind IN ('REBUILD_KV', 'RECALC_NAV')
            AND ledger_revision <= ? AND status != 'DONE'
        `, [row.portfolio_id, Number(row.ledger_revision)]);
        if (Number(dependency && dependency.count || 0) > 0) continue;
        // On-demand export always reads current revision; this outbox item is
        // an observable invalidation rather than a stored binary workbook.
        await db.prepare(`
          UPDATE ledger_outbox SET status = 'DONE', attempts = attempts + 1,
            processed_at = ?, last_error = NULL
          WHERE portfolio_id = ? AND kind = 'REBUILD_EXCEL'
            AND ledger_revision <= ? AND status IN ('PENDING', 'FAILED')
        `).bind(now(), row.portfolio_id, Number(row.ledger_revision)).run();
      } else {
        continue;
      }
      results.push({ id: row.outbox_id, kind: row.kind, ok: true });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const status = attempts >= 8 ? 'FAILED' : 'PENDING';
      const delay = Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(attempts, 8));
      await db.prepare(`
        UPDATE ledger_outbox SET status = ?, attempts = ?, available_at = ?, last_error = ?
        WHERE outbox_id = ?
      `).bind(status, attempts, now() + delay, String(error.message || error).slice(0, 1000), row.outbox_id).run();
      results.push({ id: row.outbox_id, kind: row.kind, ok: false, error: error.message });
    }
  }
  return { ok: results.every(item => item.ok), processed: results.length, results };
}

export async function ledgerHealth(env) {
  try {
    const db = ledgerDb(env);
    const row = await dbFirst(db, `
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'ledger_portfolios', 'ledger_source_records', 'ledger_pending',
        'ledger_transaction_guards', 'ledger_events', 'ledger_audit_log',
        'ledger_exports', 'ledger_imports', 'ledger_import_rows',
        'ledger_outbox', 'ledger_prices', 'ledger_nav_snapshots'
      )
    `);
    const outbox = await dbFirst(db, `
      SELECT COUNT(*) AS pending FROM ledger_outbox WHERE status IN ('PENDING', 'FAILED')
    `).catch(() => ({ pending: 0 }));
    return { ready: Number(row && row.count || 0) === 12, outboxPending: Number(outbox && outbox.pending || 0) };
  } catch (error) {
    return { ready: false, outboxPending: null };
  }
}

export async function handleLedgerAdminRequest(request, env, context = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.startsWith('/api/admin/ledger')) return null;
  const respond = context.respond || ((data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }));
  const actor = String(context.actor || 'admin');
  try {
    const db = ledgerDb(env);
    if (path === '/api/admin/ledger' && request.method === 'GET') {
      const portfolio = portfolioId(url.searchParams.get('portfolio'));
      const status = upper(url.searchParams.get('status') || 'ALL');
      if (!['ALL', 'PENDING', 'CONFIRMED', 'REJECTED'].includes(status)) {
        throw new LedgerHttpError(400, 'status 無效');
      }
      const state = await portfolioRow(db, portfolio);
      const where = status === 'ALL' ? '' : ' AND status = ?';
      const pendingRows = status === 'CONFIRMED' ? [] : await dbAll(db, `
        SELECT * FROM ledger_pending WHERE portfolio_id = ?${where}
        ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, trade_date DESC, created_at DESC
        LIMIT 500
      `, status === 'ALL' ? [portfolio] : [portfolio, status]);
      const events = status === 'PENDING' || status === 'REJECTED'
        ? [] : await activeEvents(db, portfolio, Number(state.ledger_revision));
      const [navRows, priceRows, priceHistory] = await Promise.all([
        loadNavSnapshots(db, portfolio, Number(state.ledger_revision)),
        loadLatestPrices(db, portfolio, Number(state.ledger_revision)),
        loadPriceHistory(db, portfolio, Number(state.ledger_revision)),
      ]);
      const projection = events.length ? enrichProjectionPrices(replay(events, portfolio, {
        corporateActionPrices: priceHistory,
      }), priceRows) : null;
      if (projection) projection.nav_rows = navRows;
      return respond({
        ok: true, portfolio, currency: PORTFOLIOS[portfolio].currency,
        ledgerRevision: Number(state.ledger_revision),
        pending: pendingRows.map(pendingItem), events, navRows, priceRows, projection,
      });
    }
    if (path === '/api/admin/ledger/pending' && request.method === 'POST') {
      const body = await readJson(request);
      const portfolio = portfolioId(body.portfolio);
      const created = await createPending(db, portfolio, body.event, actor, {
        source: body.source || 'MANUAL',
        idempotencyKey: body.idempotencyKey,
        sourceRef: body.sourceRef,
      });
      return respond({ ok: true, duplicate: created.duplicate, item: created.item }, created.duplicate ? 200 : 201);
    }
    if (path === '/api/admin/ledger/pending/update' && request.method === 'POST') {
      return respond({ ok: true, item: await updatePending(db, await readJson(request), actor) });
    }
    if (path === '/api/admin/ledger/pending/reject' && request.method === 'POST') {
      return respond({ ok: true, item: await rejectPending(db, await readJson(request), actor) });
    }
    if (path === '/api/admin/ledger/pending/confirm' && request.method === 'POST') {
      const confirmed = await confirmPending(db, env, await readJson(request), actor);
      if (typeof context.defer === 'function' && typeof context.refreshPortfolio === 'function') {
        context.defer(drainLedgerOutbox(env, {
          portfolio: confirmed.item.portfolio,
          refreshPortfolio: context.refreshPortfolio,
        }).catch(error => console.error('ledger_confirm_outbox_failed', error)));
      }
      return respond({ ok: true, ...confirmed });
    }
    if (path === '/api/admin/ledger/export' && request.method === 'GET') {
      return respond({ ok: true, ...await createExport(db, portfolioId(url.searchParams.get('portfolio')), actor) });
    }
    if (path === '/api/admin/ledger/import/preview' && request.method === 'POST') {
      return respond(await previewImport(db, await readJson(request), actor));
    }
    if (path === '/api/admin/ledger/import/confirm' && request.method === 'POST') {
      return respond(await confirmImport(db, await readJson(request), actor));
    }
    if (path === '/api/admin/ledger/source' && request.method === 'POST') {
      return respond(await ingestSourceRecord(db, await readJson(request), actor), 201);
    }
    if (path === '/api/admin/ledger/migration/preview' && request.method === 'POST') {
      return respond(await previewLegacyMigration(db, await readJson(request), actor));
    }
    if (path === '/api/admin/ledger/migration/confirm' && request.method === 'POST') {
      const confirmed = await confirmLegacyMigration(db, env, await readJson(request), actor);
      if (typeof context.defer === 'function' && typeof context.refreshPortfolio === 'function') {
        context.defer(drainLedgerOutbox(env, {
          portfolio: confirmed.portfolio,
          refreshPortfolio: context.refreshPortfolio,
        }).catch(error => console.error('ledger_migration_outbox_failed', error)));
      }
      return respond(confirmed);
    }
    if (path === '/api/admin/ledger/outbox' && request.method === 'POST') {
      const body = await readJson(request);
      return respond(await drainLedgerOutbox(env, {
        portfolio: body.portfolio || null,
        refreshPortfolio: context.refreshPortfolio,
      }));
    }
    throw new LedgerHttpError(404, 'Not found');
  } catch (error) {
    if (error instanceof LedgerHttpError) {
      return respond({ error: error.message, details: error.details }, error.status);
    }
    console.error('ledger_admin_request_failed', error);
    return respond({ error: '賬本服務暫時發生錯誤' }, 500);
  }
}
