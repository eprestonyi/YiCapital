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
const AUTOMATION_EVENT_TYPES = new Set([
  'DIVIDEND', 'CORPORATE_ACTION', 'LIABILITY', 'FUND_ACTION',
]);
const TAX_REVIEW_EVENT_TYPES = new Set([
  'BUY', 'SELL', 'DIVIDEND', 'CORPORATE_ACTION', 'FUND_ACTION',
]);
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
const MAX_NAV_BATCH_ROWS = 800;
const MAX_RAW_PRICE_TAPE_ROWS = 40_000;
const RAW_PRICE_TAPE_CHUNK_ROWS = 500;
const ACTIVE_POSITION_EPSILON = 1e-12;
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
function dateInTimeZone(timeZone, timestamp = now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function currentPortfolioDate(portfolio, timestamp = now()) {
  const timeZone = portfolio === 'us'
    ? 'America/New_York'
    : portfolio === 'a' ? 'Asia/Shanghai' : 'Asia/Hong_Kong';
  return dateInTimeZone(timeZone, timestamp);
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
  // Dividend price is a display-only derivative of authoritative Amount / quantity.
  // Legacy workbooks retained more precision here than the reversible Excel format,
  // so hashing it would turn an untouched export into a false UPDATE.
  if (upper(copy.event_type || copy.type) === 'DIVIDEND') delete copy.price;
  return copy;
}
const canonicalHash = event => sha256Hex(stableJson(stripSyncFields(event)));

function cashAuditFingerprint(event) {
  const source = event && typeof event === 'object' ? event : {};
  const fields = [
    'gross_amount_minor', 'tax_amount_minor', 'fee_amount_minor', 'net_cash_minor',
    'gross_amount', 'tax_amount', 'transaction_tax', 'withholding_tax', 'fees',
    'net_amount', 'net_cash', 'amount', 'cash_amount', 'cash_change',
  ];
  return stableJson(Object.fromEntries(fields.map(field => [field, source[field] ?? null])));
}

function markExcelTaxReview(currentEvent, excelEvent) {
  if (!TAX_REVIEW_EVENT_TYPES.has(excelEvent.event_type) ||
      cashAuditFingerprint(currentEvent) === cashAuditFingerprint(excelEvent)) {
    return excelEvent;
  }
  return {
    ...excelEvent,
    tax_status: 'PENDING_RECONFIRMATION',
    tax_review_required: true,
    tax_review_reason: 'Excel 修改了 Amount/Cash 或稅費拆分；必須在 Pending 重新核對。',
  };
}

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

export async function currentLedgerRevision(env, requestedPortfolio) {
  const portfolio = portfolioId(requestedPortfolio);
  const row = await portfolioRow(ledgerDb(env), portfolio);
  return Number(row.ledger_revision);
}

export async function portfolioDerivationState(env, requestedPortfolio) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const state = await portfolioRow(db, portfolio);
  const ledgerRevision = Number(state.ledger_revision);
  const pending = await dbFirst(db, `
    SELECT COUNT(*) AS count
    FROM ledger_outbox
    WHERE portfolio_id = ? AND ledger_revision = ?
      AND kind IN ('REBUILD_KV', 'RECALC_NAV')
      AND status IN ('PENDING', 'FAILED', 'PROCESSING')
  `, [portfolio, ledgerRevision]);
  const pendingCount = Number(pending && pending.count || 0);
  return {
    ledgerRevision,
    derivedWorkPending: pendingCount > 0,
    pendingCount,
  };
}

export async function assertLedgerRevision(env, requestedPortfolio, expectedLedgerRevision) {
  const expected = Number(expectedLedgerRevision);
  const current = await currentLedgerRevision(env, requestedPortfolio);
  if (!Number.isInteger(expected) || current !== expected) {
    throw new LedgerHttpError(
      409,
      '賬本 revision 已變更',
      { code: 'LEDGER_REVISION_CHANGED' },
    );
  }
  return current;
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

async function earliestActiveEventDate(db, portfolio, maxRevision) {
  const revision = Number(maxRevision);
  const row = await dbFirst(db, `
    SELECT MIN(e.trade_date) AS affected_from
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
  `, [portfolio, revision, revision, revision]);
  return row && row.affected_from ? String(row.affected_from).slice(0, 10) : null;
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

async function requestDerivedRebuild(db, body, actor) {
  const requestedPortfolio = String(body.portfolio || '').trim();
  if (!requestedPortfolio) throw new LedgerHttpError(422, 'portfolio 必須明確指定 us/hk/a');
  const portfolio = portfolioId(requestedPortfolio);
  const reason = String(body.reason || '').trim();
  if (!reason) throw new LedgerHttpError(422, 'reason 必須說明重算原因');
  if (reason.length > 500) throw new LedgerHttpError(422, 'reason 不可超過 500 個字元');

  const state = await portfolioRow(db, portfolio);
  const ledgerRevision = Number(state.ledger_revision);
  const affectedFrom = await earliestActiveEventDate(db, portfolio, ledgerRevision);
  if (!affectedFrom) {
    throw new LedgerHttpError(409, '目前沒有可重算的 confirmed active event');
  }

  // A tape that never produced even one NAV snapshot is a failed staging
  // artifact, not published historical truth. A deliberate admin rebuild may
  // discard exactly that current-revision artifact so a repaired provider can
  // refreeze it; any tape with a persisted NAV row remains immutable.
  const unpublishedTape = await dbFirst(db, `
    SELECT price_tape_id FROM ledger_price_tapes t
    WHERE portfolio_id = ? AND ledger_revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM ledger_nav_snapshots n
        WHERE n.portfolio_id = t.portfolio_id
          AND n.ledger_revision = t.ledger_revision
      )
    LIMIT 1
  `, [portfolio, ledgerRevision]);
  const discardCandidatePriceTapeId = unpublishedTape && unpublishedTape.price_tape_id || null;

  const timestamp = now();
  const guardId = makeId('ltg');
  const requestId = makeId('ldr');
  const kinds = ['RECALC_NAV', 'REBUILD_KV', 'REBUILD_EXCEL'];
  // An administrator rebuild is also the recovery path for a tape that is
  // internally complete but has not yet appended the provider's newest EOD
  // session.  Force the NAV worker to probe the official raw-close watermark
  // instead of taking the publish-only fast path for the existing tape.
  const payload = stableJson({ affectedFrom, probeEod: true, reason });
  try {
    const batchResults = await db.batch([
      ...(discardCandidatePriceTapeId ? [
        db.prepare(`
          DELETE FROM ledger_price_tape_rows
          WHERE price_tape_id = ?
            AND EXISTS (
              SELECT 1 FROM ledger_price_tapes t
              WHERE t.price_tape_id = ?
                AND t.portfolio_id = ? AND t.ledger_revision = ?
                AND NOT EXISTS (
                  SELECT 1 FROM ledger_nav_snapshots n
                  WHERE n.portfolio_id = t.portfolio_id
                    AND n.ledger_revision = t.ledger_revision
                )
            )
        `).bind(
          discardCandidatePriceTapeId, discardCandidatePriceTapeId,
          portfolio, ledgerRevision,
        ),
        db.prepare(`
          DELETE FROM ledger_price_tapes
          WHERE price_tape_id = ? AND portfolio_id = ? AND ledger_revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM ledger_nav_snapshots n
              WHERE n.portfolio_id = ledger_price_tapes.portfolio_id
                AND n.ledger_revision = ledger_price_tapes.ledger_revision
            )
        `).bind(discardCandidatePriceTapeId, portfolio, ledgerRevision),
      ] : []),
      db.prepare(`
        INSERT INTO ledger_transaction_guards (
          guard_id, pending_id, expected_pending_version,
          portfolio_id, expected_ledger_revision, created_at
        ) VALUES (
          ?, ?, 1,
          (SELECT portfolio_id FROM ledger_portfolios
            WHERE portfolio_id = ? AND ledger_revision = ?),
          ?, ?
        )
      `).bind(
        guardId, requestId, portfolio, ledgerRevision,
        ledgerRevision, timestamp,
      ),
      ...kinds.map(kind => db.prepare(`
        INSERT INTO ledger_outbox (
          outbox_id, portfolio_id, ledger_revision, kind, payload_json,
          status, attempts, available_at, last_error, created_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, ?, NULL)
        ON CONFLICT(portfolio_id, ledger_revision, kind) DO UPDATE SET
          payload_json = excluded.payload_json,
          status = 'PENDING',
          attempts = 0,
          available_at = excluded.available_at,
          last_error = NULL,
          processed_at = NULL
      `).bind(
        makeId('lob'), portfolio, ledgerRevision, kind, payload,
        timestamp, timestamp,
      )),
      db.prepare(`
        INSERT INTO ledger_audit_log (
          audit_id, portfolio_id, actor_type, actor_ref, action,
          target_type, target_id, before_json, after_json, metadata_json, created_at
        ) VALUES (?, ?, 'ADMIN', ?, 'DERIVED_REBUILD_REQUESTED',
          'PORTFOLIO', ?, NULL, ?, ?, ?)
      `).bind(
        makeId('lau'), portfolio, actor, portfolio,
        stableJson({ ledgerRevision, affectedFrom, kinds, status: 'PENDING' }),
        stableJson({ requestId, reason, discardCandidatePriceTapeId }), timestamp,
      ),
      db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
    ]);
    const discardedPriceTapeId = discardCandidatePriceTapeId &&
      changedRows(batchResults[1]) > 0 ? discardCandidatePriceTapeId : null;
    return {
      ok: true,
      portfolio,
      ledgerRevision,
      affectedFrom,
      kinds,
      requestId,
      discardedPriceTapeId,
    };
  } catch (error) {
    const current = await portfolioRow(db, portfolio);
    if (Number(current.ledger_revision) !== ledgerRevision) {
      throw new LedgerHttpError(
        409,
        '重算排隊時 ledger revision 已改變，請刷新後重試',
        { code: 'LEDGER_REVISION_CHANGED' },
      );
    }
    throw error;
  }

}
function replay(items, portfolio, options = {}) {
  try {
    return replayPortfolioLedger(engineEvents(items), {
      portfolio,
      currency: PORTFOLIOS[portfolio].currency,
      include_pending: false,
      corporate_action_prices: options.corporateActionPrices || [],
      as_of_date: options.asOfDate || currentPortfolioDate(portfolio),
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
  if (['MANUAL', 'EXCEL'].includes(source) && !MANUAL_EVENT_TYPES.has(event.event_type)) {
    throw new LedgerHttpError(422,
      '人工新增只允許交易和股東申購/贖回；股息、公司行動、負債與基金行動必須由自動來源進入 Pending。');
  }
  if (source === 'AUTOMATION' && !AUTOMATION_EVENT_TYPES.has(event.event_type)) {
    throw new LedgerHttpError(422,
      '自動來源只允許股息、公司行動、負債與基金行動；BUY、SELL、CAPITAL 必須由人工或簽名 Excel 進入 Pending。');
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
  if (event.event_type !== current.event_type) {
    throw new LedgerHttpError(422, 'Pending 事件類型不可修改；請驳回後以正確類型重新建立。');
  }
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
  const suppliedTotalAssetsMinor = scaledInteger(
    raw.total_assets ?? raw.totalAssets,
    100,
    `${date} total_assets`,
  );
  const liabilityMinor = scaledInteger(raw.liability, 100, `${date} liability`);
  const suppliedNetValueMinor = scaledInteger(
    raw.net_value ?? raw.netValue,
    100,
    `${date} net_value`,
  );
  if (Math.abs(suppliedTotalAssetsMinor - cashMinor - marketValueMinor) > 2) {
    throw new LedgerHttpError(422, `${date} NAV 總資產不等於現金加持倉市值`);
  }
  if (Math.abs(suppliedNetValueMinor - suppliedTotalAssetsMinor + liabilityMinor) > 2) {
    throw new LedgerHttpError(422, `${date} NAV 淨值不等於總資產減負債`);
  }
  // Persist the accounting identities from their authoritative components.
  // Independently rounded floating totals can otherwise differ by one cent
  // when a raw counter price lands on a half-cent boundary.
  const totalAssetsMinor = cashMinor + marketValueMinor;
  const netValueMinor = totalAssetsMinor - liabilityMinor;
  const liabilityAssetRatioMicros = scaledInteger(
    raw.liability_asset_ratio ?? raw.liabilityAssetRatio ??
      (totalAssetsMinor ? liabilityMinor / totalAssetsMinor : 0),
    1_000_000,
    `${date} liability_asset_ratio`,
    true,
  );
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
  if (unitsMicros < 0 || (unitsMicros > 0 && unitNavMicros == null)) {
    throw new LedgerHttpError(422, `${date} NAV 份額或單位淨值無效`);
  }
  if (unitsMicros > 0 && unitNavMicros != null) {
    const expectedUnitNavMicros = Math.round(
      (suppliedNetValueMinor / 100) / (unitsMicros / 1_000_000) * 1_000_000,
    );
    // The supplied net value is rounded to cents while Python-compatible unit
    // NAV is calculated from the exact, pre-display net value. Permit only the
    // mathematically unavoidable half-cent storage delta plus one micro for
    // unit-NAV rounding; this is not a loose accounting tolerance.
    const units = unitsMicros / 1_000_000;
    const unitNavToleranceMicros = Math.max(
      2,
      Math.ceil((0.005 / units) * 1_000_000) + 1,
    );
    if (!Number.isSafeInteger(expectedUnitNavMicros) ||
        Math.abs(unitNavMicros - expectedUnitNavMicros) > unitNavToleranceMicros) {
      throw new LedgerHttpError(422, `${date} NAV 單位淨值不等於淨值除以總份額`);
    }
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

function normalizedTapeTickers(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toUpperCase())
    .filter(Boolean))].sort();
}

function tapeTickersAreSubset(observedTickers, requiredTickers) {
  const required = new Set(requiredTickers);
  return observedTickers.every(ticker => required.has(ticker));
}

function rawTapeError(message, code = 'HISTORICAL_NAV_PRICE_TAPE_INVALID') {
  return new LedgerHttpError(409, message, { code });
}

function trustedRawCloseSource(source) {
  const value = String(source || '');
  return /^tushare:/.test(value) || value === 'yahoo:query2-chart' ||
    value === 'us-raw-close:yahoo+chartexchange';
}

function rawTapeCanonicalRows(rows) {
  return rows.map(row => [
    row.ticker,
    row.price_date,
    Number(row.price_micros),
    row.source,
    row.source_ref || null,
  ]);
}

async function rawTapeHash({
  portfolio,
  ledgerRevision,
  tapeFrom,
  tapeThrough,
  calendarFrom,
  calendarDates,
  requiredTickers,
  priceSource,
  calendarSource,
  calendarSourceRef,
  parentPriceTapeId = null,
  inheritedThrough = null,
  priceRows,
}) {
  return sha256Hex(stableJson({
    portfolio,
    ledgerRevision,
    tapeFrom,
    tapeThrough,
    calendarFrom,
    calendarDates,
    requiredTickers,
    priceBasis: 'raw_close',
    adjusted: false,
    priceSource,
    calendarSource,
    calendarSourceRef: calendarSourceRef || null,
    parentPriceTapeId: parentPriceTapeId || null,
    inheritedThrough: inheritedThrough || null,
    priceRows: rawTapeCanonicalRows(priceRows),
  }));
}

/** Read one complete raw-close replay tape from storage isolated from live prices. */
export async function loadFrozenLedgerPriceTape(
  env,
  requestedPortfolio,
  expectedLedgerRevision,
  expectations = {},
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const ledgerRevision = Number(expectedLedgerRevision);
  if (!Number.isInteger(ledgerRevision) || ledgerRevision < 0) {
    throw rawTapeError('歷史價格帶缺少有效 ledger revision');
  }
  const manifest = await dbFirst(db, `
    SELECT * FROM ledger_price_tapes
    WHERE portfolio_id = ? AND ledger_revision = ?
    LIMIT 1
  `, [portfolio, ledgerRevision]);
  if (!manifest) return null;

  const tapeFrom = String(manifest.tape_from || '').slice(0, 10);
  const tapeThrough = String(manifest.tape_through || '').slice(0, 10);
  const calendarFrom = String(manifest.calendar_from || '').slice(0, 10);
  const rawCalendarDates = parseJson(manifest.calendar_dates_json, []);
  const calendarDates = Array.isArray(rawCalendarDates)
    ? rawCalendarDates.map(value => String(value || '').slice(0, 10))
    : [];
  const requiredTickers = normalizedTapeTickers(parseJson(manifest.required_tickers_json, []));
  const priceSource = String(manifest.price_source || '');
  const tapeId = String(manifest.price_tape_id || '');
  const tapeHash = String(manifest.price_tape_hash || '');
  const parentPriceTapeId = String(manifest.parent_price_tape_id || '') || null;
  const inheritedThrough = String(manifest.inherited_through || '').slice(0, 10) || null;
  const datesAreValid = calendarDates.length > 0 &&
    calendarDates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) &&
    calendarDates.every((date, index) => index === 0 || calendarDates[index - 1] < date) &&
    calendarDates[0] >= calendarFrom && calendarDates.at(-1) === tapeThrough;
  if (manifest.price_basis !== 'raw_close' || Number(manifest.adjusted) !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(tapeFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(tapeThrough) || tapeFrom > tapeThrough ||
      !/^\d{4}-\d{2}-\d{2}$/.test(calendarFrom) || calendarFrom > tapeThrough ||
      !datesAreValid || !trustedRawCloseSource(priceSource) ||
      !/^raw-close:[a-z]+:\d+$/.test(tapeId) ||
      (parentPriceTapeId == null) !== (inheritedThrough == null) ||
      parentPriceTapeId && !/^raw-close:[a-z]+:\d+$/.test(parentPriceTapeId) ||
      inheritedThrough && (!/^\d{4}-\d{2}-\d{2}$/.test(inheritedThrough) ||
        inheritedThrough > tapeThrough) ||
      !/^[a-f0-9]{64}$/.test(tapeHash)) {
    throw rawTapeError('D1 歷史 raw-close 價格帶標記無效');
  }

  const expectedFrom = String(expectations.tapeFrom || '').slice(0, 10);
  const expectedThrough = String(expectations.tapeThrough || '').slice(0, 10);
  const expectedCalendarFrom = String(expectations.calendarFrom || '').slice(0, 10);
  const expectedTickers = normalizedTapeTickers(expectations.requiredTickers);
  const expectedSource = String(expectations.priceSource || '');
  const expectedTapeId = String(expectations.priceTapeId || '');
  if (expectedFrom && tapeFrom !== expectedFrom ||
      expectedThrough && tapeThrough !== expectedThrough ||
      expectedCalendarFrom && calendarFrom !== expectedCalendarFrom ||
      Object.hasOwn(expectations, 'requiredTickers') &&
        stableJson(requiredTickers) !== stableJson(expectedTickers) ||
      expectedSource && priceSource !== expectedSource ||
      expectedTapeId && tapeId !== expectedTapeId) {
    throw rawTapeError('D1 歷史 raw-close 價格帶與本次重放不匹配');
  }

  const rows = await dbAll(db, `
    SELECT * FROM ledger_price_tape_rows
    WHERE price_tape_id = ?
    ORDER BY ticker, price_date
  `, [tapeId]);
  const priceRows = rows.map(row => ({
    ticker: String(row.ticker || '').toUpperCase(),
    price_date: String(row.price_date || '').slice(0, 10),
    price_micros: Number(row.price_micros),
    source: String(row.source || ''),
    source_ref: row.source_ref || null,
  }));
  const observedTickers = normalizedTapeTickers(priceRows.map(row => row.ticker));
  const rowsAreValid = priceRows.length <= MAX_RAW_PRICE_TAPE_ROWS &&
    priceRows.every(row => row.price_micros > 0 && row.source === priceSource &&
      row.price_date >= tapeFrom && row.price_date <= tapeThrough &&
      calendarDates.includes(row.price_date));
  if (!tapeTickersAreSubset(observedTickers, requiredTickers) || !rowsAreValid ||
      Number(manifest.price_row_count) !== priceRows.length) {
    throw rawTapeError('D1 歷史 raw-close 價格帶不完整');
  }
  const calculatedHash = await rawTapeHash({
    portfolio,
    ledgerRevision,
    tapeFrom,
    tapeThrough,
    calendarFrom,
    calendarDates,
    requiredTickers,
    priceSource,
    calendarSource: String(manifest.calendar_source || ''),
    calendarSourceRef: String(manifest.calendar_source_ref || ''),
    parentPriceTapeId,
    inheritedThrough,
    priceRows,
  });
  if (calculatedHash !== tapeHash) {
    throw rawTapeError('D1 歷史 raw-close 價格帶 hash 不一致');
  }
  return {
    portfolio,
    ledgerRevision,
    tapeFrom,
    tapeThrough,
    calendarFrom,
    calendarDates,
    calendarSource: String(manifest.calendar_source || ''),
    calendarSourceRef: String(manifest.calendar_source_ref || ''),
    parentPriceTapeId,
    inheritedThrough,
    requiredTickers,
    priceSource,
    priceTapeId: tapeId,
    priceTapeHash: tapeHash,
    priceRows: priceRows.map(row => ({
      ticker: row.ticker,
      date: row.price_date,
      price: row.price_micros / 1_000_000,
      close: row.price_micros / 1_000_000,
      source: row.source,
      sourceRef: row.source_ref,
      valuation: {
        immutableRawPriceTape: true,
        priceBasis: 'raw_close',
        adjusted: false,
        priceTapeId: tapeId,
        priceTapeHash: tapeHash,
      },
    })),
  };
}

/** Load the newest validated tape strictly before a ledger revision. */
export async function loadPriorFrozenLedgerPriceTape(
  env,
  requestedPortfolio,
  beforeLedgerRevision,
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const revision = Number(beforeLedgerRevision);
  if (!Number.isInteger(revision) || revision <= 0) return null;
  const row = await dbFirst(db, `
    SELECT ledger_revision FROM ledger_price_tapes
    WHERE portfolio_id = ? AND ledger_revision < ?
    ORDER BY ledger_revision DESC LIMIT 1
  `, [portfolio, revision]);
  return row
    ? loadFrozenLedgerPriceTape(env, portfolio, Number(row.ledger_revision))
    : null;
}

/** Queue one current-revision EOD tape extension without changing the ledger. */
export async function enqueueDailyNavReplay(env, requestedPortfolios = ['us', 'hk', 'a']) {
  const db = ledgerDb(env);
  const portfolios = [...new Set(requestedPortfolios.map(portfolioId))];
  const queued = [];
  for (const portfolio of portfolios) {
    const state = await portfolioRow(db, portfolio);
    const ledgerRevision = Number(state.ledger_revision);
    if (!(ledgerRevision > 0)) continue;
    const tape = await loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision);
    if (!tape) continue;
    const timestamp = now();
    const guardId = makeId('ltg');
    const outboxId = makeId('lob');
    const payload = stableJson({
      affectedFrom: tape.tapeThrough,
      probeEod: true,
      reason: 'scheduled-eod-raw-tape-extension',
    });
    const followUpEod = stableJson({
      affectedFrom: tape.tapeThrough,
      reason: 'scheduled-eod-raw-tape-extension',
      requestedAt: timestamp,
    });
    await db.batch([
      db.prepare(`
        INSERT INTO ledger_transaction_guards (
          guard_id, pending_id, expected_pending_version,
          portfolio_id, expected_ledger_revision, created_at
        ) VALUES (
          ?, ?, 1,
          (SELECT portfolio_id FROM ledger_portfolios
           WHERE portfolio_id = ? AND ledger_revision = ?),
          ?, ?
        )
      `).bind(
        guardId, `daily-nav:${portfolio}:${ledgerRevision}`,
        portfolio, ledgerRevision, ledgerRevision, timestamp,
      ),
      db.prepare(`
        INSERT INTO ledger_outbox (
          outbox_id, portfolio_id, ledger_revision, kind, payload_json,
          status, attempts, available_at, last_error, created_at, processed_at
        )
        SELECT ?, ?, ?, 'RECALC_NAV', ?, 'PENDING', 0, ?, NULL, ?, NULL
        FROM ledger_transaction_guards WHERE guard_id = ?
        ON CONFLICT(portfolio_id, ledger_revision, kind) DO UPDATE SET
          payload_json = CASE
            WHEN ledger_outbox.status = 'DONE' THEN excluded.payload_json
            ELSE json_set(
              CASE WHEN json_valid(ledger_outbox.payload_json)
                THEN ledger_outbox.payload_json ELSE '{}' END,
              '$.followUpEod', json(?)
            )
          END,
          status = CASE WHEN ledger_outbox.status = 'DONE'
            THEN 'PENDING' ELSE ledger_outbox.status END,
          attempts = CASE WHEN ledger_outbox.status = 'DONE'
            THEN 0 ELSE ledger_outbox.attempts END,
          available_at = CASE WHEN ledger_outbox.status = 'DONE'
            THEN excluded.available_at ELSE ledger_outbox.available_at END,
          last_error = CASE WHEN ledger_outbox.status = 'DONE'
            THEN NULL ELSE ledger_outbox.last_error END,
          processed_at = CASE WHEN ledger_outbox.status = 'DONE'
            THEN NULL ELSE ledger_outbox.processed_at END
      `).bind(
        outboxId, portfolio, ledgerRevision, payload,
        timestamp, timestamp, guardId, followUpEod,
      ),
      db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
    ]);
    queued.push({ portfolio, ledgerRevision, affectedFrom: tape.tapeThrough });
  }
  return queued;
}

/** Freeze price rows and the complete trading-day calendar in one D1 batch. */
export async function freezeLedgerPriceTape(
  env,
  requestedPortfolio,
  rawTape,
  expectedLedgerRevision,
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const ledgerRevision = Number(expectedLedgerRevision);
  if (!Number.isInteger(ledgerRevision) || ledgerRevision < 0) {
    throw rawTapeError('歷史價格帶缺少有效 ledger revision');
  }
  const input = rawTape && typeof rawTape === 'object' ? rawTape : {};
  const tapeFrom = String(input.tapeFrom || '').slice(0, 10);
  const tapeThrough = String(input.tapeThrough || '').slice(0, 10);
  const calendarFrom = String(input.calendarFrom || '').slice(0, 10);
  const requiredTickers = normalizedTapeTickers(input.requiredTickers);
  const calendarDates = (Array.isArray(input.calendarDates) ? input.calendarDates : [])
    .map(value => String(value || '').slice(0, 10));
  const priceSource = String(input.priceSource || '');
  const calendarSource = String(input.calendarSource || '');
  const calendarSourceRef = String(input.calendarSourceRef || '').slice(0, 240);
  const parentPriceTapeId = String(input.parentPriceTapeId || '').trim() || null;
  const inheritedThrough = String(input.inheritedThrough || '').slice(0, 10) || null;
  if (input.priceBasis !== 'raw_close' || input.adjusted !== false ||
      !/^\d{4}-\d{2}-\d{2}$/.test(tapeFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(tapeThrough) || tapeFrom > tapeThrough ||
      !/^\d{4}-\d{2}-\d{2}$/.test(calendarFrom) || calendarFrom > tapeThrough ||
      !calendarDates.length || calendarDates.at(-1) !== tapeThrough ||
      calendarDates.some((date, index) => !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < calendarFrom || date > tapeThrough || index > 0 && calendarDates[index - 1] >= date) ||
      !trustedRawCloseSource(priceSource) || !/^tushare:/.test(calendarSource) ||
      (parentPriceTapeId == null) !== (inheritedThrough == null) ||
      parentPriceTapeId && !/^raw-close:[a-z]+:\d+$/.test(parentPriceTapeId) ||
      inheritedThrough && (!/^\d{4}-\d{2}-\d{2}$/.test(inheritedThrough) ||
        inheritedThrough > tapeThrough)) {
    throw rawTapeError('歷史 raw-close 價格帶輸入無效');
  }
  const timestamp = now();
  const priceKeys = new Set();
  const priceRows = (Array.isArray(input.priceRows) ? input.priceRows : []).map((raw, index) => {
    const ticker = String(raw && (raw.ticker || raw.symbol) || '').trim().toUpperCase().slice(0, 32);
    const priceDate = String(raw && (raw.date || raw.price_date) || '').slice(0, 10);
    const key = `${ticker}:${priceDate}`;
    const priceMicros = scaledInteger(raw && (raw.close ?? raw.price), 1_000_000, `${ticker} price`);
    const source = String(raw && raw.source || '').slice(0, 100);
    if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(priceDate) ||
        priceDate < tapeFrom || priceDate > tapeThrough || priceKeys.has(key) ||
        !calendarDates.includes(priceDate) || !(priceMicros > 0) || source !== priceSource) {
      throw rawTapeError(`第 ${index + 1} 筆 raw-close 價格無效或重複`);
    }
    priceKeys.add(key);
    return {
      ticker,
      price_date: priceDate,
      price_micros: priceMicros,
      source,
      source_ref: String(raw.sourceRef || raw.source_ref || '').slice(0, 240) || null,
    };
  }).sort((left, right) => left.ticker.localeCompare(right.ticker) ||
    left.price_date.localeCompare(right.price_date));
  const observedTickers = normalizedTapeTickers(priceRows.map(row => row.ticker));
  if (priceRows.length > MAX_RAW_PRICE_TAPE_ROWS ||
      !tapeTickersAreSubset(observedTickers, requiredTickers)) {
    throw rawTapeError('歷史 raw-close 價格帶包含 required 以外 ticker 或行數過大');
  }
  const priorTape = await loadPriorFrozenLedgerPriceTape(env, portfolio, ledgerRevision);
  if (priorTape && (parentPriceTapeId !== priorTape.priceTapeId ||
      inheritedThrough !== priorTape.tapeThrough)) {
    throw rawTapeError(
      '新 ledger revision 必須繼承直前 raw-close 價格帶的完整 overlap',
      'HISTORICAL_NAV_PRICE_TAPE_PARENT_REQUIRED',
    );
  }
  if (!priorTape && parentPriceTapeId) {
    throw rawTapeError(
      'raw-close parent 不是直前有效價格帶',
      'HISTORICAL_NAV_PRICE_TAPE_PARENT_INVALID',
    );
  }
  if (parentPriceTapeId) {
    const parentMatch = parentPriceTapeId.match(/^raw-close:([a-z]+):(\d+)$/);
    const parentRevision = Number(parentMatch && parentMatch[2]);
    if (!parentMatch || parentMatch[1] !== portfolio || !(parentRevision < ledgerRevision)) {
      throw rawTapeError('raw-close parent 價格帶 revision 無效');
    }
    const parent = await loadFrozenLedgerPriceTape(env, portfolio, parentRevision, {
      priceTapeId: parentPriceTapeId,
    });
    if (!parent || inheritedThrough > parent.tapeThrough) {
      throw rawTapeError('raw-close parent 價格帶不存在或繼承範圍無效');
    }
    const commonTickers = new Set(
      requiredTickers.filter(ticker => parent.requiredTickers.includes(ticker)),
    );
    // A later revision can introduce a newly confirmed back-dated event. In
    // that case the child legitimately has a freshly fetched calendar/price
    // prefix before the parent tape began. Only the overlapping parent range
    // is immutable; dates which never existed in the parent are not part of
    // the inherited prefix contract.
    const inheritedCalendarFrom = calendarFrom > parent.calendarFrom
      ? calendarFrom
      : parent.calendarFrom;
    const inheritedPriceFrom = tapeFrom > parent.tapeFrom
      ? tapeFrom
      : parent.tapeFrom;
    const parentCalendarPrefix = parent.calendarDates
      .filter(date => date >= inheritedCalendarFrom && date <= inheritedThrough);
    const currentCalendarPrefix = calendarDates
      .filter(date => date >= inheritedCalendarFrom && date <= inheritedThrough);
    const parentPricePrefix = parent.priceRows
      .filter(row => commonTickers.has(row.ticker) && row.date >= inheritedPriceFrom &&
        row.date <= inheritedThrough)
      .map(row => ({
        ticker: row.ticker,
        price_date: row.date,
        price_micros: Math.round(Number(row.price) * 1_000_000),
        source: row.source,
        source_ref: row.sourceRef || null,
      }));
    const currentPricePrefix = priceRows
      .filter(row => commonTickers.has(row.ticker) &&
        row.price_date >= inheritedPriceFrom && row.price_date <= inheritedThrough);
    if (stableJson(currentCalendarPrefix) !== stableJson(parentCalendarPrefix) ||
        stableJson(rawTapeCanonicalRows(currentPricePrefix)) !==
          stableJson(rawTapeCanonicalRows(parentPricePrefix))) {
      throw rawTapeError(
        '跨 revision raw-close 價格帶必須逐行繼承 parent prefix',
        'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
      );
    }
  }
  const priceTapeHash = await rawTapeHash({
    portfolio,
    ledgerRevision,
    tapeFrom,
    tapeThrough,
    calendarFrom,
    calendarDates,
    requiredTickers,
    priceSource,
    calendarSource,
    calendarSourceRef,
    parentPriceTapeId,
    inheritedThrough,
    priceRows,
  });
  const priceTapeId = `raw-close:${portfolio}:${ledgerRevision}`;
  const existing = await loadFrozenLedgerPriceTape(
    env,
    portfolio,
    ledgerRevision,
    { requiredTickers, priceSource, priceTapeId },
  );
  if (existing) {
    if (existing.tapeFrom === tapeFrom && existing.tapeThrough === tapeThrough &&
        existing.calendarFrom === calendarFrom && existing.priceTapeHash === priceTapeHash) {
      return existing;
    }
    throw rawTapeError(
      '同一 ledger revision 已存在不同的 immutable raw-close 價格帶',
      'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
    );
  }

  const storedRows = priceRows.map(row => ({
    price_tape_id: priceTapeId,
    ticker: row.ticker,
    price_date: row.price_date,
    price_micros: row.price_micros,
    source: row.source,
    source_ref: row.source_ref,
    observed_at: timestamp,
  }));
  const guardId = makeId('ltg');
  const statements = [
    db.prepare(`
      INSERT INTO ledger_transaction_guards (
        guard_id, pending_id, expected_pending_version,
        portfolio_id, expected_ledger_revision, created_at
      ) VALUES (
        ?, ?, 1,
        (SELECT portfolio_id FROM ledger_portfolios
         WHERE portfolio_id = ? AND ledger_revision = ?
           AND NOT EXISTS (
             SELECT 1 FROM ledger_price_tapes
             WHERE portfolio_id = ? AND ledger_revision = ?
           )),
        ?, ?
      )
    `).bind(
      guardId, `raw-price-tape:${portfolio}:${ledgerRevision}`,
      portfolio, ledgerRevision, portfolio, ledgerRevision,
      ledgerRevision, timestamp,
    ),
    db.prepare(`
      INSERT INTO ledger_price_tapes (
        price_tape_id, portfolio_id, ledger_revision, tape_from, tape_through,
        calendar_from, required_tickers_json, calendar_dates_json,
        price_source, calendar_source, calendar_source_ref,
        parent_price_tape_id, inherited_through,
        price_basis, adjusted, price_tape_hash, price_row_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'raw_close', 0, ?, ?, ?)
    `).bind(
      priceTapeId, portfolio, ledgerRevision, tapeFrom, tapeThrough,
      calendarFrom, stableJson(requiredTickers), stableJson(calendarDates),
      priceSource, calendarSource, calendarSourceRef || null,
      parentPriceTapeId, inheritedThrough,
      priceTapeHash, storedRows.length, timestamp,
    ),
  ];
  for (let offset = 0; offset < storedRows.length; offset += RAW_PRICE_TAPE_CHUNK_ROWS) {
    const chunk = storedRows.slice(offset, offset + RAW_PRICE_TAPE_CHUNK_ROWS);
    statements.push(db.prepare(`
      INSERT INTO ledger_price_tape_rows (
        price_tape_id, ticker, price_date, price_micros,
        source, source_ref, observed_at
      )
      SELECT
        json_extract(value, '$.price_tape_id'), json_extract(value, '$.ticker'),
        json_extract(value, '$.price_date'), json_extract(value, '$.price_micros'),
        json_extract(value, '$.source'), json_extract(value, '$.source_ref'),
        json_extract(value, '$.observed_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(chunk)));
  }
  statements.push(
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const currentRevision = await portfolioRow(db, portfolio)
      .then(row => Number(row.ledger_revision))
      .catch(() => null);
    if (currentRevision !== null && currentRevision !== ledgerRevision) {
      throw rawTapeError(
        '歷史 raw-close 價格帶寫入時 ledger revision 已變更',
        'LEDGER_REVISION_CHANGED',
      );
    }
    const raced = await loadFrozenLedgerPriceTape(
      env,
      portfolio,
      ledgerRevision,
      {
        tapeFrom,
        tapeThrough,
        calendarFrom,
        requiredTickers,
        priceSource,
        priceTapeId,
      },
    ).catch(() => null);
    if (raced) return raced;
    throw rawTapeError(
      '同一 ledger revision 已存在不同的 immutable raw-close 價格帶',
      'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
    );
  }
  return loadFrozenLedgerPriceTape(
    env,
    portfolio,
    ledgerRevision,
    {
      tapeFrom,
      tapeThrough,
      calendarFrom,
      requiredTickers,
      priceSource,
      priceTapeId,
    },
  );
}

/**
 * Append future EOD sessions without changing any already-frozen calendar date
 * or price row. The manifest hash advances atomically; the tape id and prefix
 * remain stable for the ledger revision.
 */
export async function extendLedgerPriceTape(
  env,
  requestedPortfolio,
  rawExtension,
  expectedLedgerRevision,
) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const ledgerRevision = Number(expectedLedgerRevision);
  const input = rawExtension && typeof rawExtension === 'object' ? rawExtension : {};
  const existing = await loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision, {
    priceTapeId: String(input.priceTapeId || ''),
    requiredTickers: input.requiredTickers,
    priceSource: String(input.priceSource || ''),
  });
  if (!existing) throw rawTapeError('待延伸的 raw-close 價格帶不存在');
  if (String(input.expectedPriceTapeHash || '') !== existing.priceTapeHash) {
    throw rawTapeError(
      'raw-close 價格帶延伸基準 hash 已改變',
      'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
    );
  }
  const appendedCalendarDates = (Array.isArray(input.calendarDates) ? input.calendarDates : [])
    .map(value => String(value || '').slice(0, 10));
  const tapeThrough = appendedCalendarDates.at(-1) || '';
  if (!appendedCalendarDates.length ||
      appendedCalendarDates.some((date, index) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= existing.tapeThrough ||
        index > 0 && appendedCalendarDates[index - 1] >= date) ||
      tapeThrough <= existing.tapeThrough ||
      String(input.calendarSource || '') !== existing.calendarSource ||
      String(input.calendarSourceRef || '') !== existing.calendarSourceRef) {
    throw rawTapeError('raw-close 價格帶延伸 calendar 無效');
  }
  const priceKeys = new Set();
  const timestamp = now();
  const appendedRows = (Array.isArray(input.priceRows) ? input.priceRows : []).map((raw, index) => {
    const ticker = String(raw && (raw.ticker || raw.symbol) || '').trim().toUpperCase().slice(0, 32);
    const priceDate = String(raw && (raw.date || raw.price_date) || '').slice(0, 10);
    const priceMicros = scaledInteger(raw && (raw.close ?? raw.price), 1_000_000, `${ticker} price`);
    const source = String(raw && raw.source || '').slice(0, 100);
    const key = `${ticker}:${priceDate}`;
    if (!ticker || !appendedCalendarDates.includes(priceDate) || priceKeys.has(key) ||
        !(priceMicros > 0) || source !== existing.priceSource) {
      throw rawTapeError(`第 ${index + 1} 筆延伸 raw-close 價格無效或重複`);
    }
    priceKeys.add(key);
    return {
      price_tape_id: existing.priceTapeId,
      ticker,
      price_date: priceDate,
      price_micros: priceMicros,
      source,
      source_ref: String(raw.sourceRef || raw.source_ref || '').slice(0, 240) || null,
      observed_at: timestamp,
    };
  }).sort((left, right) => left.ticker.localeCompare(right.ticker) ||
    left.price_date.localeCompare(right.price_date));
  const appendedTickers = normalizedTapeTickers(appendedRows.map(row => row.ticker));
  if (appendedTickers.some(ticker => !existing.requiredTickers.includes(ticker)) ||
      existing.priceRows.length + appendedRows.length > MAX_RAW_PRICE_TAPE_ROWS) {
    throw rawTapeError('延伸 raw-close 價格包含未知 ticker 或行數過大');
  }

  const combinedCalendarDates = [...existing.calendarDates, ...appendedCalendarDates];
  const existingCanonicalRows = existing.priceRows.map(row => ({
    ticker: row.ticker,
    price_date: row.date,
    price_micros: Math.round(Number(row.price) * 1_000_000),
    source: row.source,
    source_ref: row.sourceRef || null,
  }));
  const combinedRows = [...existingCanonicalRows, ...appendedRows]
    .sort((left, right) => left.ticker.localeCompare(right.ticker) ||
      left.price_date.localeCompare(right.price_date));
  const nextHash = await rawTapeHash({
    portfolio,
    ledgerRevision,
    tapeFrom: existing.tapeFrom,
    tapeThrough,
    calendarFrom: existing.calendarFrom,
    calendarDates: combinedCalendarDates,
    requiredTickers: existing.requiredTickers,
    priceSource: existing.priceSource,
    calendarSource: existing.calendarSource,
    calendarSourceRef: existing.calendarSourceRef,
    parentPriceTapeId: existing.parentPriceTapeId,
    inheritedThrough: existing.inheritedThrough,
    priceRows: combinedRows,
  });
  const guardId = makeId('ltg');
  const statements = [db.prepare(`
    INSERT INTO ledger_transaction_guards (
      guard_id, pending_id, expected_pending_version,
      portfolio_id, expected_ledger_revision, created_at
    ) VALUES (
      ?, ?, 1,
      (SELECT portfolio_id FROM ledger_portfolios
       WHERE portfolio_id = ? AND ledger_revision = ?
         AND EXISTS (
           SELECT 1 FROM ledger_price_tapes
           WHERE price_tape_id = ? AND portfolio_id = ? AND ledger_revision = ?
             AND tape_through = ? AND price_tape_hash = ?
         )),
      ?, ?
    )
  `).bind(
    guardId, `extend-price-tape:${portfolio}:${ledgerRevision}`,
    portfolio, ledgerRevision,
    existing.priceTapeId, portfolio, ledgerRevision,
    existing.tapeThrough, existing.priceTapeHash,
    ledgerRevision, timestamp,
  )];
  for (let offset = 0; offset < appendedRows.length; offset += RAW_PRICE_TAPE_CHUNK_ROWS) {
    const chunk = appendedRows.slice(offset, offset + RAW_PRICE_TAPE_CHUNK_ROWS);
    statements.push(db.prepare(`
      INSERT INTO ledger_price_tape_rows (
        price_tape_id, ticker, price_date, price_micros,
        source, source_ref, observed_at
      )
      SELECT
        json_extract(value, '$.price_tape_id'), json_extract(value, '$.ticker'),
        json_extract(value, '$.price_date'), json_extract(value, '$.price_micros'),
        json_extract(value, '$.source'), json_extract(value, '$.source_ref'),
        json_extract(value, '$.observed_at')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)
    `).bind(stableJson(chunk)));
  }
  statements.push(
    db.prepare(`
      UPDATE ledger_price_tapes
      SET tape_through = ?, calendar_dates_json = ?, price_tape_hash = ?,
        price_row_count = ?
      WHERE price_tape_id = ? AND portfolio_id = ? AND ledger_revision = ?
        AND tape_through = ? AND price_tape_hash = ?
    `).bind(
      tapeThrough, stableJson(combinedCalendarDates), nextHash, combinedRows.length,
      existing.priceTapeId, portfolio, ledgerRevision,
      existing.tapeThrough, existing.priceTapeHash,
    ),
    db.prepare('DELETE FROM ledger_transaction_guards WHERE guard_id = ?').bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const currentRevision = await portfolioRow(db, portfolio)
      .then(row => Number(row.ledger_revision))
      .catch(() => null);
    if (currentRevision !== null && currentRevision !== ledgerRevision) {
      throw rawTapeError(
        'raw-close 價格帶延伸時 ledger revision 已變更',
        'LEDGER_REVISION_CHANGED',
      );
    }
    const raced = await loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision, {
      priceTapeId: existing.priceTapeId,
      requiredTickers: existing.requiredTickers,
      priceSource: existing.priceSource,
    }).catch(() => null);
    if (raced && raced.priceTapeHash === nextHash && raced.tapeThrough === tapeThrough) return raced;
    throw rawTapeError(
      'raw-close 價格帶延伸與另一寫入衝突',
      'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
    );
  }
  return loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision, {
    tapeThrough,
    priceTapeId: existing.priceTapeId,
    requiredTickers: existing.requiredTickers,
    priceSource: existing.priceSource,
  });
}

function enrichProjectionPrices(projection, priceRows, options = {}) {
  if (!projection || !Array.isArray(projection.positions)) return projection;
  const prices = new Map((priceRows || []).map(row => [row.ticker, row]));
  const active = projection.positions.filter(row =>
    Number(row.quantity ?? row.qty ?? 0) > ACTIVE_POSITION_EPSILON)
    .map(row => {
      const quantity = Number(row.quantity ?? row.qty ?? 0);
      const ticker = String(row.ticker || '').toUpperCase();
      const observation = prices.get(ticker);
      const valuation = observation && observation.valuation || {};
      const priceBasis = String(valuation.priceBasis || '').toLowerCase();
      const price = Number(observation && observation.price);
      if (!observation || !(price > 0) || valuation.adjusted !== false ||
          !['raw_close', 'raw_counter'].includes(priceBasis) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(String(observation.date || '')) ||
          options.requiredDate && observation.date !== options.requiredDate) {
        throw rawTapeError(
          `${ticker || '未知 ticker'} 缺少本次估值日的 raw counter/raw-close 價格`,
          'RAW_NAV_PRICE_MISSING',
        );
      }
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
        price_source: observation.source,
        price_source_ref: observation.sourceRef || null,
        price_basis: valuation.priceBasis,
        price_adjusted: valuation.adjusted,
        price_tape_id: valuation.priceTapeId || null,
      };
    });
  const totalMarketValue = active.reduce((sum, row) => sum + Number(row.market_value || 0), 0);
  projection.positions = active.map(row => ({
    ...row,
    weight: totalMarketValue ? Number(row.market_value) / totalMarketValue : 0,
  }));
  projection.as_of = options.valuationDate ||
    (priceRows || []).map(row => row.date).filter(Boolean).sort().at(-1) || null;
  return projection;
}

async function replayWithStoredValuationPrices(
  env,
  portfolio,
  ledgerRevision,
  events,
  navRows,
  livePriceRows,
  livePriceHistory,
  options = {},
) {
  // A current-revision raw tape is authoritative for historical replay.
  // Mutable ledger_prices may be used only for one verified current-session
  // row after the frozen EOD tape; there is never a book/reference fallback.
  const tape = await loadFrozenLedgerPriceTape(env, portfolio, ledgerRevision);
  const latestNavDate = (Array.isArray(navRows) ? navRows : [])
    .map(row => String(row && row.date || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const projection = replay(events, portfolio, {
    corporateActionPrices: tape ? tape.priceRows : livePriceHistory,
  });
  if (!tape) {
    if (ledgerRevision > 0 || events.length) {
      throw rawTapeError(
        '當前 ledger revision 缺少凍結 raw-close 價格帶',
        'CURRENT_REVISION_RAW_TAPE_MISSING',
      );
    }
    return {
      projection: enrichProjectionPrices(projection, livePriceRows),
      priceRows: livePriceRows,
      priceTape: null,
      rawTapeValuation: false,
    };
  }
  if (latestNavDate && latestNavDate > tape.tapeThrough) {
    const postTapeRows = (Array.isArray(navRows) ? navRows : [])
      .filter(row => row.date > tape.tapeThrough);
    const latestNav = postTapeRows.at(-1);
    const latestValuation = latestNav && latestNav.valuation || {};
    const latestBasis = String(latestValuation.priceBasis || '').toLowerCase();
    const verifiedCurrentDate = String(options.currentDate || currentPortfolioDate(portfolio)).slice(0, 10);
    const hasActivePositions = (projection.positions || []).some(row =>
      Number(row.quantity ?? row.qty ?? 0) > ACTIVE_POSITION_EPSILON);
    const verifiedCashOnly = latestBasis === 'cash_only' && !hasActivePositions &&
      latestValuation.sessionVerified === true &&
      String(latestValuation.quoteDate || '').slice(0, 10) === latestNavDate &&
      String(latestValuation.source || '').trim().length > 0;
    const verifiedRawPrice = ['raw_close', 'raw_counter'].includes(latestBasis);
    if (postTapeRows.length !== 1 || latestNavDate !== verifiedCurrentDate ||
        Number(latestNav && latestNav.ledgerRevision) !== ledgerRevision ||
        latestValuation.adjusted !== false ||
        (!verifiedRawPrice && !verifiedCashOnly)) {
      throw rawTapeError(
        '價格帶之後只允許一筆當日、同 revision 的 raw counter/raw-close；零持倉可用已核驗 cash-only NAV',
        'RAW_NAV_CURRENT_SESSION_INVALID',
      );
    }
    return {
      projection: enrichProjectionPrices(projection, livePriceRows, {
        requiredDate: latestNavDate,
        valuationDate: latestNavDate,
      }),
      priceRows: livePriceRows,
      priceTape: tape,
      rawTapeValuation: false,
    };
  }

  const valuationDate = latestNavDate || tape.tapeThrough;
  const latestByTicker = new Map();
  for (const row of tape.priceRows) {
    if (row.date > valuationDate) continue;
    const current = latestByTicker.get(row.ticker);
    if (!current || current.date < row.date) latestByTicker.set(row.ticker, row);
  }
  const activeTickers = (projection.positions || [])
    .filter(row => Number(row.quantity ?? row.qty ?? 0) > ACTIVE_POSITION_EPSILON)
    .map(row => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean);
  const missing = [...new Set(activeTickers)]
    .filter(ticker => !latestByTicker.has(ticker))
    .sort();
  if (missing.length) {
    throw rawTapeError(
      `raw-close 價格帶在 ${valuationDate} 缺少持倉價格：${missing.join(',')}`,
      'HISTORICAL_NAV_PRICE_TAPE_GAP',
    );
  }
  const effectiveRows = [...latestByTicker.values()]
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
  const enriched = enrichProjectionPrices(projection, effectiveRows, { valuationDate });
  enriched.price_basis = 'raw_close';
  enriched.price_adjusted = false;
  enriched.price_tape_id = tape.priceTapeId;
  enriched.as_of = valuationDate;
  return {
    projection: enriched,
    priceRows: effectiveRows,
    priceTape: tape,
    rawTapeValuation: true,
  };
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
  const inferredSources = [...new Set((Array.isArray(rawPrices) ? rawPrices : [])
    .map(price => String(price && price.source || '').trim())
    .filter(Boolean))];
  row.source = String(rawSnapshot.source ||
    (inferredSources.length === 1 ? inferredSources[0] : 'UNKNOWN_RAW_PRICE_SOURCE'))
    .trim().slice(0, 100);
  if (!row.source) row.source = 'UNKNOWN_RAW_PRICE_SOURCE';
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
  const pruneAfter = batch.pruneAfter === true;
  const preserveCurrentSessionDate = String(
    batch.preserveCurrentSessionDate || '',
  ).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(replaceFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(replaceThrough) || replaceFrom > replaceThrough) {
    throw new LedgerHttpError(422, '歷史 NAV 替換日期範圍無效');
  }
  const rawRows = Array.isArray(batch.navRows) ? batch.navRows : [];
  if (!rawRows.length || rawRows.length > MAX_NAV_BATCH_ROWS) {
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
  if (pruneAfter) {
    // Remove stale/future derived rows after the frozen EOD target, but retain
    // one same-revision, session-verified current counter. A long historical
    // replay can finish after the market closes, when the minute cron can no
    // longer recreate a counter row that it wrote earlier that day.
    statements.push(db.prepare(`
      DELETE FROM ledger_nav_snapshots
      WHERE portfolio_id = ? AND nav_date > ? AND ledger_revision <= ?
        AND NOT (
          ledger_revision = ? AND nav_date = ?
          AND json_extract(valuation_json, '$.adjusted') = 0
          AND LOWER(COALESCE(
            json_extract(valuation_json, '$.priceBasis'),
            json_extract(valuation_json, '$.price_basis'), ''
          )) IN ('raw_counter', 'raw_close', 'cash_only')
          AND COALESCE(
            json_extract(valuation_json, '$.sessionVerified'),
            json_extract(valuation_json, '$.session_verified'), 0
          ) = 1
          AND COALESCE(
            json_extract(valuation_json, '$.quoteDate'),
            json_extract(valuation_json, '$.quote_date'), ''
          ) = nav_date
        )
    `).bind(
      portfolio, replaceThrough, revision,
      revision, /^\d{4}-\d{2}-\d{2}$/.test(preserveCurrentSessionDate)
        ? preserveCurrentSessionDate : '',
    ));
  }
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
    const currentRevision = await portfolioRow(db, portfolio)
      .then(row => Number(row.ledger_revision))
      .catch(() => null);
    if (currentRevision !== null && currentRevision !== revision) {
      throw new LedgerHttpError(
        409,
        '歷史 NAV 重建寫入時賬本 revision 已變更',
        { code: 'LEDGER_REVISION_CHANGED' },
      );
    }
    throw error;
  }
  return {
    ok: true,
    portfolio,
    ledgerRevision: revision,
    replaceFrom,
    replaceThrough,
    prunedAfter: pruneAfter ? replaceThrough : null,
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
  const taxStatus = upper(event.tax_status);
  if (event.tax_review_required === true ||
      taxStatus === 'PENDING_RECONFIRMATION' || taxStatus === 'UNKNOWN_LEGACY') {
    throw new LedgerHttpError(422,
      '稅項尚未確認；請先在 Pending 修改 gross / tax / fees 並保存，再 Confirm。',
      { code: 'TAX_REVIEW_REQUIRED' });
  }
  if (event.trade_date > currentPortfolioDate(portfolio)) {
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
  // Negative cash remains part of the exact cash arithmetic but is not a
  // warning or confirmation blocker.
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
        stableJson({ reason, negativeCashIgnored: true, baseEventId }), timestamp
      ),
      ...['RECALC_NAV', 'REBUILD_KV', 'REBUILD_EXCEL'].map(kind => db.prepare(`
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
  return {
    item: eventItem(await dbFirst(db, 'SELECT * FROM ledger_events WHERE event_id = ?', [eventId])),
    ledgerRevision: revision,
    projection: afterProjection,
  };
}

async function createExport(env, db, portfolio, actor) {
  const state = await portfolioRow(db, portfolio);
  const ledgerRevision = Number(state.ledger_revision);
  const derivation = await portfolioDerivationState(env, portfolio);
  if (derivation.ledgerRevision !== ledgerRevision || derivation.derivedWorkPending) {
    throw new LedgerHttpError(
      409,
      '當前 revision 的現金、持倉或 NAV 尚未重算完成，Excel 暫不可導出',
      { code: 'DERIVED_WORK_PENDING', pendingCount: derivation.pendingCount },
    );
  }
  const [events, navRows, priceRows, priceHistory] = await Promise.all([
    activeEvents(db, portfolio, ledgerRevision),
    loadNavSnapshots(db, portfolio, ledgerRevision),
    loadLatestPrices(db, portfolio, ledgerRevision),
    loadPriceHistory(db, portfolio, ledgerRevision),
  ]);
  const valued = await replayWithStoredValuationPrices(
    env, portfolio, ledgerRevision, events, navRows, priceRows, priceHistory,
  );
  const projection = valued.projection;
  if (ledgerRevision > 0) {
    const tape = valued.priceTape;
    const navByDate = new Map(navRows.map(row => [row.date, row]));
    const coverageReady = !!tape && tape.calendarDates.every(date => navByDate.has(date));
    const noDirtyRows = navRows.every(row => row.recalculationRequired !== true);
    const latestNav = navRows.at(-1);
    const postTapeRows = tape ? navRows.filter(row => row.date > tape.tapeThrough) : [];
    const exactTarget = !!tape && !!latestNav &&
      (latestNav.date === tape.tapeThrough ||
        postTapeRows.length === 1 && latestNav.date === currentPortfolioDate(portfolio)) &&
      Number(navByDate.get(tape.tapeThrough)?.ledgerRevision) === ledgerRevision;
    if (!coverageReady || !noDirtyRows || !exactTarget) {
      throw new LedgerHttpError(
        409,
        'raw-close 歷史 NAV 還未完整對齊當前 revision，Excel 暫不可導出',
        { code: 'RAW_NAV_NOT_READY' },
      );
    }
  }
  const unsafeValuation = (projection.positions || []).some(position => {
    const basis = String(position.price_basis || '').toLowerCase();
    return position.price_source === 'ledger-fallback' || position.price_adjusted !== false ||
      (basis !== 'raw_close' && basis !== 'raw_counter');
  });
  if (unsafeValuation) {
    throw new LedgerHttpError(
      409,
      'raw counter／raw-close 估值尚未完成，Excel 暫不可導出',
      { code: 'RAW_NAV_NOT_READY' },
    );
  }
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
    priceRows: valued.priceRows,
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
    if (event.event_type !== current.eventType) {
      operations.push({
        operationId, operation: 'ERROR', reason: 'EVENT_TYPE_IMMUTABLE',
        error: 'Excel 不可把已有事件改成另一類；請保留原事件類型。',
        sheetName, rowNumber, eventId: current.eventId, lineageId,
        current: current.event, excel: event,
      });
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
    const stagedEvent = markExcelTaxReview(current.event, event);
    operations.push({
      operationId, operation, reason, sheetName, rowNumber,
      eventId: current.eventId, lineageId, baseEventVersion: current.eventVersion,
      base: base && base.event || null, current: current.event, excel: stagedEvent,
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
    if (row.operation === 'CREATE' && !MANUAL_EVENT_TYPES.has(event.event_type)) {
      throw new LedgerHttpError(422, 'Excel CREATE 只允許 BUY、SELL 或 CAPITAL。');
    }
    if (row.operation === 'UPDATE' &&
        (!current || event.event_type !== current.event_type)) {
      throw new LedgerHttpError(422, 'Excel UPDATE 事件類型不可變更。');
    }
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
  if (!AUTOMATION_EVENT_TYPES.has(event.event_type)) {
    throw new LedgerHttpError(422,
      '自動 source record 只允許 DIVIDEND、CORPORATE_ACTION、LIABILITY 或 FUND_ACTION。');
  }
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
  if (rawNavRows.length) throw new LedgerHttpError(422,
    'historical_nav_rows 必須為空；NAV Statement 只可離線核驗，不得成為數據庫 seed。',
    { code: 'LEGACY_DERIVED_SEED_FORBIDDEN' });
  const historicalNavRows = [];
  const rawPriceRows = body.historicalPriceRows ?? body.historical_price_rows ?? [];
  if (!Array.isArray(rawPriceRows)) throw new LedgerHttpError(422, 'historical_price_rows 必須是陣列');
  if (rawPriceRows.length) throw new LedgerHttpError(422,
    'historical_price_rows 必須為空；Asset Position 只可離線核驗，不得成為價格 seed。',
    { code: 'LEGACY_DERIVED_SEED_FORBIDDEN' });
  const historicalPriceRows = [];
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
  if (preview.exactDuplicates.length && acknowledgement.duplicates !== true) {
    throw new LedgerHttpError(422, '必須明確確認保留完全重複事件');
  }
  if (preview.unknownTaxEvents && acknowledgement.unknownTax !== true) {
    throw new LedgerHttpError(422, '必須明確確認歷史稅項維持 UNKNOWN_LEGACY');
  }
  if (Number(preview.historicalNavRowCount || 0) !== 0 ||
      Number(preview.historicalPriceRowCount || 0) !== 0 ||
      (preview.historicalNavRows || []).length || (preview.historicalPriceRows || []).length) {
    throw new LedgerHttpError(409,
      '此舊 Preview 含有派生 NAV/價格 seed，已永久禁止；請以只含事件的 package 重新 Preview。',
      { code: 'LEGACY_DERIVED_SEED_FORBIDDEN' });
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
  const navRows = [];
  const priceRows = [];
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
    ...['RECALC_NAV', 'REBUILD_KV', 'REBUILD_EXCEL'].map(kind => db.prepare(`
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
    p: Number(row.price ?? row.p ?? 0),
    mv: projectionNumber(row.market_value ?? row.mv, row.market_value_minor),
    netCost: projectionNumber(row.net_cost ?? row.netCost, row.net_cost_minor),
    buyCost: projectionNumber(row.total_buy_cost ?? row.buyCost, row.total_buy_cost_minor),
    sellProceeds: projectionNumber(row.sell_proceeds ?? row.sellProceeds, row.sell_proceeds_minor),
    dividend: projectionNumber(row.dividend_income ?? row.dividend, row.dividend_income_minor),
    pnl: projectionNumber(row.total_pnl ?? row.pnl, row.total_pnl_minor),
    priceDate: row.price_date || null,
    priceSource: row.price_source || null,
    priceSourceRef: row.price_source_ref || null,
    priceBasis: row.price_basis || null,
    priceAdjusted: row.price_adjusted == null ? null : row.price_adjusted === true,
    priceTapeId: row.price_tape_id || null,
  })).filter(row => row.t && row.q > ACTIVE_POSITION_EPSILON);
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

/**
 * Read the immutable D1 event facts needed to start a NAV replay before a
 * current-revision KV ledger exists. This intentionally contains no prices or
 * valuation fallback; the replay must build and freeze its raw-close tape.
 */
export async function loadLedgerReplayInput(env, requestedPortfolio, expectedLedgerRevision = null) {
  const portfolio = portfolioId(requestedPortfolio);
  const db = ledgerDb(env);
  const state = await portfolioRow(db, portfolio);
  const ledgerRevision = Number(state.ledger_revision);
  if (expectedLedgerRevision != null && ledgerRevision !== Number(expectedLedgerRevision)) {
    throw new LedgerHttpError(
      409,
      'NAV replay ledger revision 已變更',
      { code: 'LEDGER_REVISION_CHANGED' },
    );
  }
  const [events, navRows] = await Promise.all([
    activeEvents(db, portfolio, ledgerRevision),
    loadNavSnapshots(db, portfolio, ledgerRevision),
  ]);
  if (ledgerRevision > 0 && !events.length) {
    throw new LedgerHttpError(
      409,
      '當前 ledger revision 沒有 confirmed active event',
      { code: 'CURRENT_REVISION_EVENTS_MISSING' },
    );
  }
  const sourceDate = events.reduce(
    (date, item) => item.tradeDate > date ? item.tradeDate : date,
    '',
  );
  const latestNav = navRows.at(-1) || null;
  // Replay current D1 facts without any valuation price. This supplies the
  // exact post-confirm cash, holdings, liabilities and fund units needed by
  // the counter-price step while the prior-revision KV is necessarily stale.
  const projection = replay(events, portfolio, {
    asOfDate: sourceDate || currentPortfolioDate(portfolio),
  });
  const positions = projectionPositions(projection);
  const cash = finalCash(projection);
  const liability = finalLiability(projection);
  const units = finalUnits(projection);
  const fundActionAdjustments = fundActionAdjustmentByDate(events);
  const fundDividends = fundDividendByDate(events);
  const baseNetValue = latestNav
    ? Number(latestNav.netValue)
    : cash - liability;
  return {
    market: portfolio,
    portfolio,
    currency: PORTFOLIOS[portfolio].currency,
    positions,
    confirmedEvents: engineEvents(events),
    navRows,
    sourceHoldings: positions,
    cash,
    liability,
    units,
    baseMarketValue: 0,
    baseTotalAssets: cash,
    baseNetValue,
    baseMV: baseNetValue,
    history: historyFromNav(navRows, events),
    fundActionAdjustments,
    fundDividends,
    navRecalculationRequired: navRows
      .filter(row => row.recalculationRequired === true)
      .map(row => row.date),
    corporateActionPricePending: [],
    sourceDate,
    lastDate: latestNav && latestNav.date || sourceDate,
    lastUnitNav: latestNav && Number(latestNav.unitNav ?? latestNav.nav) || 0,
    ledgerRevision,
    valuationReady: false,
    source: 'd1-confirmed-event-replay-input',
  };
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
  const expectedRevision = options.expectedLedgerRevision == null
    ? null
    : Number(options.expectedLedgerRevision);
  if (expectedRevision != null && capturedRevision !== expectedRevision) {
    throw new LedgerHttpError(
      409,
      'KV materialization ledger revision 已變更',
      { code: 'LEDGER_REVISION_CHANGED' },
    );
  }
  const [events, navRows, priceRows, priceHistory] = await Promise.all([
    activeEvents(db, portfolio, capturedRevision),
    loadNavSnapshots(db, portfolio, capturedRevision),
    loadLatestPrices(db, portfolio, capturedRevision),
    loadPriceHistory(db, portfolio, capturedRevision),
  ]);
  const valued = await replayWithStoredValuationPrices(
    env, portfolio, capturedRevision, events, navRows, priceRows, priceHistory,
    { currentDate: options.currentDate },
  );
  const projection = valued.projection;
  const positions = projectionPositions(projection);
  const valuationReady = positions.every(row => {
    const basis = String(row.priceBasis || '').toLowerCase();
    return row.priceAdjusted === false &&
      (basis === 'raw_close' || basis === 'raw_counter');
  });
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
      priceSource: row.priceSource, priceBasis: row.priceBasis,
      adjusted: row.priceAdjusted, priceTapeId: row.priceTapeId,
      buyCost: row.buyCost, sellProceeds: row.sellProceeds,
      dividend: row.dividend, netCost: row.netCost, pnl: row.pnl,
    })),
    valuationReady,
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
    if (expectedRevision != null) {
      throw new LedgerHttpError(
        409,
        'KV materialization ledger revision 已變更',
        { code: 'LEDGER_REVISION_CHANGED' },
      );
    }
    await requeueLatestKv(db, portfolio, latestRevision, 'revision changed before KV write');
    if (Number(options.raceRetry || 0) < 2) {
      return materializeLedgerKv(env, portfolio, {
        ...options,
        raceRetry: Number(options.raceRetry || 0) + 1,
      });
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
    if (expectedRevision != null) {
      throw new LedgerHttpError(
        409,
        'KV materialization ledger revision 已變更',
        { code: 'LEDGER_REVISION_CHANGED' },
      );
    }
    await requeueLatestKv(db, portfolio, latestRevision, 'revision changed during KV write');
    if (Number(options.raceRetry || 0) < 2) {
      return materializeLedgerKv(env, portfolio, {
        ...options,
        raceRetry: Number(options.raceRetry || 0) + 1,
      });
    }
    throw new Error('ledger revision kept changing during KV publication');
  }
  return ledger;
}

// Cloudflare scheduled invocations have a tighter CPU ceiling than admin
// requests. Keep every continuation small enough for minute-cron replay even
// after the event history and frozen raw-price tape have grown.
const NAV_REPLAY_DEFAULT_BATCH_SIZE = 5;
const NAV_REPLAY_MAX_BATCH_SIZE = 50;

function navReplayBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return NAV_REPLAY_DEFAULT_BATCH_SIZE;
  return Math.min(NAV_REPLAY_MAX_BATCH_SIZE, parsed);
}

function revisionChangedError() {
  const error = new Error('ledger revision changed during outbox continuation');
  error.code = 'LEDGER_REVISION_CHANGED';
  return error;
}

function isRevisionChangedError(error) {
  return error && (
    error.code === 'LEDGER_REVISION_CHANGED' ||
    error.details && error.details.code === 'LEDGER_REVISION_CHANGED'
  );
}

function validNavReplayCheckpoint(value, portfolio, ledgerRevision, affectedFrom) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const phase = String(value.phase || 'replay').toLowerCase();
  const cursor = String(value.cursor || '').slice(0, 10);
  const targetThrough = String(value.targetThrough || '').slice(0, 10);
  const lastNavDate = String(value.lastNavDate || '').slice(0, 10);
  const lastUnitNav = Number(value.lastUnitNav);
  if (value.portfolio !== portfolio || Number(value.ledgerRevision) !== ledgerRevision ||
      value.affectedFrom !== affectedFrom || !['replay', 'materialize', 'publish'].includes(phase) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(targetThrough) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(lastNavDate) || !Number.isFinite(lastUnitNav) ||
      lastNavDate > targetThrough ||
      (phase === 'replay' && (!/^\d{4}-\d{2}-\d{2}$/.test(cursor) ||
        cursor <= lastNavDate || cursor > targetThrough)) ||
      (phase !== 'replay' && cursor)) {
    return null;
  }
  return { phase, cursor: cursor || null, targetThrough, lastNavDate, lastUnitNav };
}

const OUTBOX_LEASE_MS = 5 * 60_000;
const OUTBOX_DRAIN_LIMIT = 5;
const OUTBOX_CLAIM_PREFIX = 'OUTBOX_CLAIM:';

function outboxClaimLostError() {
  const error = new Error('outbox claim lease was lost');
  error.code = 'OUTBOX_CLAIM_LOST';
  return error;
}

function isOutboxClaimLostError(error) {
  return error && error.code === 'OUTBOX_CLAIM_LOST';
}

function changedRows(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

async function propagateAffectedFromAndSupersede(db, portfolio, timestamp) {
  const latest = await dbAll(db, `
    SELECT o.outbox_id, o.payload_json,
      (SELECT MIN(json_extract(p.payload_json, '$.affectedFrom'))
       FROM ledger_outbox p
       WHERE p.portfolio_id = o.portfolio_id AND p.kind = o.kind
         AND p.ledger_revision <= o.ledger_revision AND p.status != 'DONE') AS affected_from_min
    FROM ledger_outbox o
    WHERE o.status IN ('PENDING', 'FAILED')
      ${portfolio ? 'AND o.portfolio_id = ?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM ledger_outbox newer
        WHERE newer.portfolio_id = o.portfolio_id AND newer.kind = o.kind
          AND newer.ledger_revision > o.ledger_revision AND newer.status != 'DONE'
      )
  `, portfolio ? [portfolio] : []);
  for (const row of latest) {
    const affectedFrom = String(row.affected_from_min || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(affectedFrom)) continue;
    const payload = parseJson(row.payload_json, {});
    if (payload.affectedFrom === affectedFrom) continue;
    await db.prepare(`
      UPDATE ledger_outbox SET payload_json = ?
      WHERE outbox_id = ? AND status IN ('PENDING', 'FAILED')
    `).bind(stableJson({ ...payload, affectedFrom }), row.outbox_id).run();
  }

  await db.prepare(`
    UPDATE ledger_outbox
    SET status = 'DONE', available_at = ?, processed_at = ?,
      last_error = 'superseded by newer outbox revision'
    WHERE ${portfolio ? 'portfolio_id = ? AND' : ''}
      (status IN ('PENDING', 'FAILED') OR (status = 'PROCESSING' AND available_at <= ?))
      AND EXISTS (
        SELECT 1 FROM ledger_outbox newer
        WHERE newer.portfolio_id = ledger_outbox.portfolio_id
          AND newer.kind = ledger_outbox.kind
          AND newer.ledger_revision > ledger_outbox.ledger_revision
      )
  `).bind(...(portfolio
    ? [timestamp, timestamp, portfolio, timestamp]
    : [timestamp, timestamp, timestamp])).run();
}

async function claimNextOutbox(db, portfolio, allowNav) {
  const claimedAt = now();
  const candidates = await dbAll(db, `
    SELECT o.*
    FROM ledger_outbox o
    JOIN ledger_portfolios lp ON lp.portfolio_id = o.portfolio_id
      AND lp.ledger_revision = o.ledger_revision
    WHERE (
        (o.status IN ('PENDING', 'FAILED') AND o.available_at <= ?)
        OR (o.status = 'PROCESSING' AND o.available_at <= ?)
      )
      ${portfolio ? 'AND o.portfolio_id = ?' : ''}
      ${allowNav ? '' : "AND o.kind != 'RECALC_NAV'"}
      AND NOT EXISTS (
        SELECT 1 FROM ledger_outbox newer
        WHERE newer.portfolio_id = o.portfolio_id AND newer.kind = o.kind
          AND newer.ledger_revision > o.ledger_revision AND newer.status != 'DONE'
      )
      AND (
        o.kind = 'RECALC_NAV'
        OR (o.kind = 'REBUILD_KV' AND NOT EXISTS (
          SELECT 1 FROM ledger_outbox dependency
          WHERE dependency.portfolio_id = o.portfolio_id
            AND dependency.ledger_revision = o.ledger_revision
            AND dependency.kind = 'RECALC_NAV' AND dependency.status != 'DONE'
        ))
        OR (o.kind = 'REBUILD_EXCEL' AND NOT EXISTS (
          SELECT 1 FROM ledger_outbox dependency
          WHERE dependency.portfolio_id = o.portfolio_id
            AND dependency.ledger_revision = o.ledger_revision
            AND dependency.kind IN ('REBUILD_KV', 'RECALC_NAV')
            AND dependency.status != 'DONE'
        ))
      )
    ORDER BY CASE o.kind WHEN 'RECALC_NAV' THEN 0 WHEN 'REBUILD_KV' THEN 1 ELSE 2 END,
      o.created_at, o.outbox_id
    LIMIT 1
  `, portfolio ? [claimedAt, claimedAt, portfolio] : [claimedAt, claimedAt]);
  const candidate = candidates[0];
  if (!candidate) return null;

  const claimToken = OUTBOX_CLAIM_PREFIX + crypto.randomUUID();
  const leaseUntil = claimedAt + OUTBOX_LEASE_MS;
  const claimed = await db.prepare(`
    UPDATE ledger_outbox
    SET status = 'PROCESSING', available_at = ?, last_error = ?, processed_at = NULL
    WHERE outbox_id = ? AND ledger_revision = ?
      AND (
        (status IN ('PENDING', 'FAILED') AND available_at <= ?)
        OR (status = 'PROCESSING' AND available_at <= ?)
      )
      AND EXISTS (
        SELECT 1 FROM ledger_portfolios
        WHERE portfolio_id = ledger_outbox.portfolio_id
          AND ledger_revision = ledger_outbox.ledger_revision
      )
      AND NOT EXISTS (
        SELECT 1 FROM ledger_outbox newer
        WHERE newer.portfolio_id = ledger_outbox.portfolio_id
          AND newer.kind = ledger_outbox.kind
          AND newer.ledger_revision > ledger_outbox.ledger_revision
          AND newer.status != 'DONE'
      )
      AND (
        kind = 'RECALC_NAV'
        OR (kind = 'REBUILD_KV' AND NOT EXISTS (
          SELECT 1 FROM ledger_outbox dependency
          WHERE dependency.portfolio_id = ledger_outbox.portfolio_id
            AND dependency.ledger_revision = ledger_outbox.ledger_revision
            AND dependency.kind = 'RECALC_NAV' AND dependency.status != 'DONE'
        ))
        OR (kind = 'REBUILD_EXCEL' AND NOT EXISTS (
          SELECT 1 FROM ledger_outbox dependency
          WHERE dependency.portfolio_id = ledger_outbox.portfolio_id
            AND dependency.ledger_revision = ledger_outbox.ledger_revision
            AND dependency.kind IN ('REBUILD_KV', 'RECALC_NAV')
            AND dependency.status != 'DONE'
        ))
      )
  `).bind(
    leaseUntil, claimToken, candidate.outbox_id, Number(candidate.ledger_revision),
    claimedAt, claimedAt,
  ).run();
  if (changedRows(claimed) !== 1) return null;
  const row = await dbFirst(db, `
    SELECT * FROM ledger_outbox
    WHERE outbox_id = ? AND status = 'PROCESSING' AND last_error = ?
  `, [candidate.outbox_id, claimToken]);
  return row ? { row, claimToken, leaseUntil } : null;
}

async function finishOutboxClaim(
  db,
  row,
  claimToken,
  updates,
  values,
  requireCurrentRevision = true,
) {
  const result = await db.prepare(`
    UPDATE ledger_outbox SET ${updates}
    WHERE outbox_id = ? AND ledger_revision = ?
      AND status = 'PROCESSING' AND last_error = ?
      ${requireCurrentRevision ? `AND EXISTS (
        SELECT 1 FROM ledger_portfolios
        WHERE portfolio_id = ledger_outbox.portfolio_id
          AND ledger_revision = ledger_outbox.ledger_revision
      )` : ''}
  `).bind(...values, row.outbox_id, Number(row.ledger_revision), claimToken).run();
  if (changedRows(result) !== 1) throw outboxClaimLostError();
}

async function completeNavOutboxClaim(db, row, claimToken) {
  const timestamp = now();
  const hasFollowUp = `
    json_valid(payload_json)
    AND json_type(payload_json, '$.followUpEod') = 'object'
    AND json_extract(payload_json, '$.followUpEod.affectedFrom') GLOB '????-??-??'
  `;
  const result = await db.prepare(`
    UPDATE ledger_outbox SET
      payload_json = CASE WHEN ${hasFollowUp} THEN json_object(
        'affectedFrom', json_extract(payload_json, '$.followUpEod.affectedFrom'),
        'probeEod', json('true'),
        'reason', COALESCE(
          json_extract(payload_json, '$.followUpEod.reason'),
          'scheduled-eod-raw-tape-extension'
        ),
        'requestedAt', json_extract(payload_json, '$.followUpEod.requestedAt')
      ) ELSE payload_json END,
      status = CASE WHEN ${hasFollowUp} THEN 'PENDING' ELSE 'DONE' END,
      attempts = attempts + 1,
      available_at = ?,
      processed_at = CASE WHEN ${hasFollowUp} THEN NULL ELSE ? END,
      last_error = NULL
    WHERE outbox_id = ? AND ledger_revision = ?
      AND status = 'PROCESSING' AND last_error = ?
      AND EXISTS (
        SELECT 1 FROM ledger_portfolios
        WHERE portfolio_id = ledger_outbox.portfolio_id
          AND ledger_revision = ledger_outbox.ledger_revision
      )
  `).bind(
    timestamp, timestamp,
    row.outbox_id, Number(row.ledger_revision), claimToken,
  ).run();
  if (changedRows(result) !== 1) throw outboxClaimLostError();
  const completed = await dbFirst(db, `
    SELECT status, payload_json FROM ledger_outbox WHERE outbox_id = ?
  `, [row.outbox_id]);
  return {
    followUpEod: completed && completed.status === 'PENDING',
    payload: parseJson(completed && completed.payload_json, {}),
  };
}

async function outboxRemainder(db, portfolio) {
  const row = await dbFirst(db, `
    SELECT COUNT(*) AS remaining, MIN(available_at) AS next_available_at
    FROM ledger_outbox
    WHERE status IN ('PENDING', 'FAILED', 'PROCESSING')
      ${portfolio ? 'AND portfolio_id = ?' : ''}
  `, portfolio ? [portfolio] : []);
  const remaining = Number(row && row.remaining || 0);
  const nextAvailableAt = row && row.next_available_at;
  return {
    remaining,
    nextAvailableAt: nextAvailableAt == null ? null : Number(nextAvailableAt),
  };
}

export async function drainLedgerOutbox(env, options = {}) {
  const db = ledgerDb(env);
  const portfolio = options.portfolio ? portfolioId(options.portfolio) : null;
  const navBatchSize = navReplayBatchSize(options.navBatchSize);
  const results = [];
  await propagateAffectedFromAndSupersede(db, portfolio, now());
  for (let index = 0; index < OUTBOX_DRAIN_LIMIT; index += 1) {
    const claimed = await claimNextOutbox(
      db,
      portfolio,
      typeof options.refreshPortfolio === 'function',
    );
    if (!claimed) break;
    const { row, claimToken } = claimed;
    let completionDetails = null;
    try {
      if (row.kind === 'REBUILD_KV') {
        await materializeLedgerKv(env, row.portfolio_id, {
          expectedLedgerRevision: Number(row.ledger_revision),
        });
        await finishOutboxClaim(
          db,
          row,
          claimToken,
          "status = 'DONE', attempts = attempts + 1, available_at = ?, processed_at = ?, last_error = NULL",
          [now(), now()],
        );
      }
      else if (row.kind === 'RECALC_NAV' && typeof options.refreshPortfolio === 'function') {
        const expectedRevision = Number(row.ledger_revision);
        const portfolioState = await portfolioRow(db, row.portfolio_id);
        if (Number(portfolioState.ledger_revision) !== expectedRevision) {
          throw revisionChangedError();
        }
        const payload = parseJson(row.payload_json, {});
        const affectedFrom = payload.affectedFrom || null;
        const checkpoint = validNavReplayCheckpoint(
          payload.navReplay,
          row.portfolio_id,
          expectedRevision,
          affectedFrom,
        );
        const refresh = await options.refreshPortfolio(env, row.portfolio_id, {
          ledgerRevision: expectedRevision,
          affectedFrom,
          probeEod: payload.probeEod === true,
          batchSize: navBatchSize,
          phase: checkpoint && checkpoint.phase,
          cursor: checkpoint && checkpoint.cursor,
          targetThrough: checkpoint && checkpoint.targetThrough,
          lastNavDate: checkpoint && checkpoint.lastNavDate,
          previousUnitNav: checkpoint && checkpoint.lastUnitNav,
        });
        if (refresh && (refresh.skip || refresh.fallback === true)) {
          throw new Error('NAV recalculation did not complete: ' + (refresh.skip || refresh.reason || 'fallback'));
        }
        if (Number(refresh && refresh.ledgerRevision) !== expectedRevision) {
          throw revisionChangedError();
        }
        const afterRefresh = await portfolioRow(db, row.portfolio_id);
        if (Number(afterRefresh.ledger_revision) !== expectedRevision) {
          throw revisionChangedError();
        }
        if (refresh && refresh.historicalReplay === true && refresh.complete === false) {
          const nextPhase = String(refresh.nextPhase || '').toLowerCase();
          const nextCursor = String(refresh.nextCursor || '').slice(0, 10);
          const targetThrough = String(refresh.targetThrough || '').slice(0, 10);
          const lastNavDate = String(refresh.lastNavDate || '').slice(0, 10);
          const lastUnitNav = Number(refresh.lastUnitNav);
          if (!['replay', 'materialize', 'publish'].includes(nextPhase) ||
              !/^\d{4}-\d{2}-\d{2}$/.test(targetThrough) ||
              !/^\d{4}-\d{2}-\d{2}$/.test(lastNavDate) ||
              !Number.isFinite(lastUnitNav) || lastNavDate > targetThrough ||
              (nextPhase === 'replay' && (!/^\d{4}-\d{2}-\d{2}$/.test(nextCursor) ||
                nextCursor <= lastNavDate || nextCursor > targetThrough)) ||
              (nextPhase !== 'replay' && nextCursor)) {
            throw new Error('NAV recalculation returned an invalid continuation');
          }
          const nextPayload = stableJson({
            ...payload,
            affectedFrom,
            navReplay: {
              portfolio: row.portfolio_id,
              ledgerRevision: expectedRevision,
              affectedFrom,
              phase: nextPhase,
              cursor: nextCursor || null,
              targetThrough,
              lastNavDate,
              lastUnitNav,
            },
          });
          await finishOutboxClaim(
            db,
            row,
            claimToken,
            `payload_json = CASE
              WHEN json_valid(payload_json)
                AND json_type(payload_json, '$.followUpEod') = 'object'
              THEN json_set(
                ?, '$.followUpEod',
                json(json_extract(payload_json, '$.followUpEod'))
              )
              ELSE ?
            END,
            status = 'PENDING', available_at = ?,
            last_error = NULL, processed_at = NULL`,
            [nextPayload, nextPayload, now()],
          );
          results.push({
            id: row.outbox_id,
            kind: row.kind,
            ok: true,
            complete: false,
            phase: refresh.phase,
            nextPhase,
            batchFrom: refresh.batchFrom,
            batchThrough: refresh.batchThrough,
            navRows: Number(refresh.navRows || 0),
            nextCursor: nextCursor || null,
            targetThrough,
          });
          break;
        }
        if (!refresh || refresh.complete !== true) {
          throw new Error('NAV recalculation completion contract missing');
        }
        completionDetails = await completeNavOutboxClaim(db, row, claimToken);
      } else if (row.kind === 'REBUILD_EXCEL') {
        const expectedRevision = Number(row.ledger_revision);
        const portfolioState = await portfolioRow(db, row.portfolio_id);
        if (Number(portfolioState.ledger_revision) !== expectedRevision) {
          throw revisionChangedError();
        }
        // On-demand export always reads current revision; this outbox item is
        // an observable invalidation rather than a stored binary workbook.
        await finishOutboxClaim(
          db,
          row,
          claimToken,
          "status = 'DONE', attempts = attempts + 1, available_at = ?, processed_at = ?, last_error = NULL",
          [now(), now()],
        );
      } else {
        throw new Error('unsupported outbox kind');
      }
      results.push({
        id: row.outbox_id,
        kind: row.kind,
        ok: true,
        complete: true,
        ...(completionDetails && completionDetails.followUpEod
          ? { followUpEod: true }
          : {}),
      });
      await propagateAffectedFromAndSupersede(db, portfolio, now());
    } catch (error) {
      if (isOutboxClaimLostError(error)) {
        results.push({
          id: row.outbox_id,
          kind: row.kind,
          ok: false,
          complete: false,
          retryable: true,
          error: 'outbox claim lost',
        });
        break;
      }
      if (isRevisionChangedError(error)) {
        const current = await portfolioRow(db, row.portfolio_id);
        const superseded = Number(current.ledger_revision) > Number(row.ledger_revision);
        try {
          if (superseded) {
            await finishOutboxClaim(
              db,
              row,
              claimToken,
              "status = 'DONE', available_at = ?, processed_at = ?, last_error = ?",
              [now(), now(), 'superseded by newer ledger revision'],
              false,
            );
          } else {
            await finishOutboxClaim(
              db,
              row,
              claimToken,
              "status = 'PENDING', available_at = ?, last_error = ?, processed_at = NULL",
              [now(), 'ledger revision changed; retry the latest outbox revision'],
            );
          }
        } catch (claimError) {
          if (!isOutboxClaimLostError(claimError)) throw claimError;
          results.push({
            id: row.outbox_id,
            kind: row.kind,
            ok: false,
            complete: false,
            retryable: true,
            error: 'outbox claim lost',
          });
          break;
        }
        if (superseded) {
          results.push({
            id: row.outbox_id,
            kind: row.kind,
            ok: true,
            complete: true,
            superseded: true,
          });
          await propagateAffectedFromAndSupersede(db, portfolio, now());
          continue;
        }
        results.push({
          id: row.outbox_id,
          kind: row.kind,
          ok: false,
          complete: false,
          retryable: true,
          error: 'ledger revision changed',
        });
        break;
      }
      const attempts = Number(row.attempts || 0) + 1;
      const status = attempts >= 8 ? 'FAILED' : 'PENDING';
      const delay = Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(attempts, 8));
      try {
        await finishOutboxClaim(
          db,
          row,
          claimToken,
          'status = ?, attempts = ?, available_at = ?, last_error = ?, processed_at = NULL',
          [status, attempts, now() + delay, String(error.message || error).slice(0, 1000)],
        );
      } catch (claimError) {
        if (!isOutboxClaimLostError(claimError)) throw claimError;
        results.push({
          id: row.outbox_id,
          kind: row.kind,
          ok: false,
          complete: false,
          retryable: true,
          error: 'outbox claim lost',
        });
        break;
      }
      results.push({ id: row.outbox_id, kind: row.kind, ok: false, error: error.message });
    }
  }
  const remainder = await outboxRemainder(db, portfolio);
  return {
    ok: results.every(item => item.ok),
    processed: results.length,
    pending: remainder.remaining > 0,
    remaining: remainder.remaining,
    nextAvailableAt: remainder.nextAvailableAt,
    results,
  };
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
        'ledger_outbox', 'ledger_prices', 'ledger_nav_snapshots',
        'ledger_price_tapes', 'ledger_price_tape_rows'
      )
    `);
    const outbox = await dbFirst(db, `
      SELECT COUNT(*) AS pending FROM ledger_outbox
      WHERE status IN ('PENDING', 'FAILED', 'PROCESSING')
    `).catch(() => ({ pending: 0 }));
    const ready = Number(row && row.count || 0) === 14;
    const rawNavPortfolios = {};
    if (ready) {
      const portfolios = await dbAll(db, `
        SELECT portfolio_id, ledger_revision FROM ledger_portfolios ORDER BY portfolio_id
      `);
      for (const state of portfolios) {
        const portfolio = state.portfolio_id;
        const revision = Number(state.ledger_revision);
        if (!(revision > 0)) {
          rawNavPortfolios[portfolio] = {
            ledgerRevision: revision,
            required: false,
            ready: true,
            reason: null,
          };
          continue;
        }
        try {
          const [tape, navRows, recalcOutbox, verifiedPriceSession] = await Promise.all([
            loadFrozenLedgerPriceTape(env, portfolio, revision),
            loadNavSnapshots(db, portfolio, revision),
            dbFirst(db, `
              SELECT COUNT(*) AS pending FROM ledger_outbox
              WHERE portfolio_id = ? AND ledger_revision = ? AND kind = 'RECALC_NAV'
                AND status IN ('PENDING', 'FAILED', 'PROCESSING')
            `, [portfolio, revision]),
            dbFirst(db, `
              SELECT MAX(price_date) AS expected_session_date
              FROM ledger_prices
              WHERE portfolio_id = ? AND ledger_revision = ?
                AND json_extract(valuation_json, '$.adjusted') = 0
                AND LOWER(COALESCE(
                  json_extract(valuation_json, '$.priceBasis'),
                  json_extract(valuation_json, '$.price_basis'), ''
                )) IN ('raw_counter', 'raw_close')
                AND COALESCE(
                  json_extract(valuation_json, '$.sessionVerified'),
                  json_extract(valuation_json, '$.session_verified'), 0
                ) = 1
                AND COALESCE(
                  json_extract(valuation_json, '$.quoteDate'),
                  json_extract(valuation_json, '$.quote_date'), ''
                ) = price_date
            `, [portfolio, revision]),
          ]);
          const navByDate = new Map(navRows.map(item => [item.date, item]));
          const coverageReady = !!tape && tape.calendarDates.every(date => navByDate.has(date));
          const noDirtyRows = navRows.every(item => item.recalculationRequired !== true);
          const last = navRows.at(-1);
          const postTapeRows = tape
            ? navRows.filter(item => item.date > tape.tapeThrough)
            : [];
          const currentCounterReady = postTapeRows.length <= 1 && postTapeRows.every(item => {
            const valuation = item.valuation && typeof item.valuation === 'object'
              ? item.valuation : {};
            const basis = String(
              valuation.priceBasis || valuation.price_basis || '',
            ).toLowerCase();
            const verifiedSession = (valuation.sessionVerified === true ||
              valuation.session_verified === true) &&
              String(valuation.quoteDate || valuation.quote_date || '').slice(0, 10) === item.date;
            const verifiedRawPrice = ['raw_counter', 'raw_close'].includes(basis) &&
              verifiedSession;
            const verifiedCashOnly = basis === 'cash_only' &&
              verifiedSession;
            return Number(item.ledgerRevision) === revision &&
              valuation.adjusted === false &&
              (verifiedRawPrice || verifiedCashOnly) &&
              String(valuation.source || '').trim().length > 0;
          });
          const exactTarget = !!tape && !!last &&
            (last.date === tape.tapeThrough || currentCounterReady && postTapeRows.length === 1) &&
            Number(navByDate.get(tape.tapeThrough)?.ledgerRevision) === revision;
          const knownVerifiedSession = String(
            verifiedPriceSession && verifiedPriceSession.expected_session_date || '',
          ).slice(0, 10) || null;
          const expectedSessionDate = [
            tape && tape.tapeThrough,
            knownVerifiedSession,
          ].filter(Boolean).sort().at(-1) || null;
          const completedSessionFresh = !!last && !!expectedSessionDate &&
            last.date >= expectedSessionDate;
          const noPendingRecalc = Number(recalcOutbox && recalcOutbox.pending || 0) === 0;
          const portfolioReady = !!tape && coverageReady && noDirtyRows &&
            completedSessionFresh && exactTarget && noPendingRecalc;
          rawNavPortfolios[portfolio] = {
            ledgerRevision: revision,
            required: true,
            ready: portfolioReady,
            tapeThrough: tape && tape.tapeThrough || null,
            latestNavDate: last && last.date || null,
            currentCounterAfterTape: currentCounterReady && postTapeRows.length === 1,
            expectedCompletedSession: expectedSessionDate,
            knownVerifiedPriceSession: knownVerifiedSession,
            completedSessionFresh,
            priceTapeId: tape && tape.priceTapeId || null,
            priceBasis: tape ? 'raw_close' : null,
            adjusted: tape ? false : null,
            reason: portfolioReady ? null
              : !tape ? 'CURRENT_REVISION_RAW_TAPE_MISSING'
              : !coverageReady ? 'NAV_CALENDAR_COVERAGE_MISSING'
                : !noDirtyRows ? 'NAV_RECALCULATION_REQUIRED'
                  : !completedSessionFresh ? 'RAW_NAV_COMPLETED_SESSION_STALE'
                    : !exactTarget ? 'NAV_TARGET_MISMATCH'
                      : 'RECALC_NAV_OUTBOX_PENDING',
          };
        } catch (error) {
          rawNavPortfolios[portfolio] = {
            ledgerRevision: revision,
            required: true,
            ready: false,
            reason: String(error && (error.code || error.message) || 'RAW_NAV_HEALTH_FAILED'),
          };
        }
      }
    }
    const rawNavReady = ready && Object.values(rawNavPortfolios).every(item => item.ready);
    return {
      ready,
      outboxPending: Number(outbox && outbox.pending || 0),
      rawNavReady,
      rawNavPortfolios,
    };
  } catch (error) {
    return {
      ready: false,
      outboxPending: null,
      rawNavReady: false,
      rawNavPortfolios: {},
    };
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
      const valued = events.length
        ? await replayWithStoredValuationPrices(
          env, portfolio, Number(state.ledger_revision), events, navRows, priceRows, priceHistory,
        )
        : null;
      const projection = valued && valued.projection;
      if (projection) projection.nav_rows = navRows;
      return respond({
        ok: true, portfolio, currency: PORTFOLIOS[portfolio].currency,
        ledgerRevision: Number(state.ledger_revision),
        pending: pendingRows.map(pendingItem), events, navRows,
        priceRows: valued ? valued.priceRows : priceRows, projection,
      });
    }
    if (path === '/api/admin/ledger/pending' && request.method === 'POST') {
      const body = await readJson(request);
      const portfolio = portfolioId(body.portfolio);
      const created = await createPending(db, portfolio, body.event, actor, {
        // This admin route is the manual fact boundary. Automation must use
        // the immutable /source endpoint, never a caller-supplied source flag.
        source: 'MANUAL',
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
      return respond({
        ok: true,
        ...await createExport(env, db, portfolioId(url.searchParams.get('portfolio')), actor),
      });
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
    if (path === '/api/admin/ledger/rebuild' && request.method === 'POST') {
      const queued = await requestDerivedRebuild(db, await readJson(request), actor);
      if (typeof context.defer === 'function' && typeof context.refreshPortfolio === 'function') {
        context.defer(drainLedgerOutbox(env, {
          portfolio: queued.portfolio,
          refreshPortfolio: context.refreshPortfolio,
        }).catch(error => console.error('ledger_derived_rebuild_outbox_failed', error)));
      }
      return respond(queued);
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
