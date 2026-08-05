/* YiCapital Admin · database-first portfolio ledger + reversible Excel */
(function () {
  'use strict';

  const { api, $ } = window.YCAdmin;
  const XLSX_EXPORT = window.XLSX;
  try { delete window.XLSX; } catch (_) { window.XLSX = undefined; }
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_IMPORT_ROWS = 1000;
  const XLSX_IMPORT_WORKER = 'assets/yc-xlsx-import-worker.js?v=20260805a';
  const MAX_LEGACY_JSON_BYTES = 2 * 1024 * 1024;
  const MAX_LEGACY_EVENTS = 120;
  const DEFAULT_REPLACE_REASON = '已核對 Excel 完整事件賬本，確認以此建立新的 active ledger revision；舊版本保留歷史。';
  const LEGACY_ACKS = [
    { key: 'duplicates', input: 'legacy-ack-duplicates', row: 'legacy-ack-duplicates-row', state: 'legacy-ack-duplicates-state' },
  ];
  const PORTFOLIOS = {
    us: { label: 'Yi Capital US', currency: 'USD', template: 'assets/data/Yi_Capital_US.xlsx', file: 'Yi_Capital_US.xlsx' },
    hk: { label: 'Yi Capital HK', currency: 'HKD', template: 'assets/data/Yi_Capital_HK.xlsx', file: 'Yi_Capital_HK.xlsx' },
    a: { label: 'Yi Capital A', currency: 'CNY', template: 'assets/data/Yi_Capital_A.xlsx', file: 'Yi_Capital_A.xlsx' },
  };
  const EVENT_LABELS = {
    BUY: 'Buy · 買入', SELL: 'Sell · 賣出', DIVIDEND: 'Dividend · 股息',
    CORPORATE_ACTION: 'Corporate Action · 公司行動', LIABILITY: 'Liability · 負債',
    CAPITAL: 'Capital · 申贖', FUND_ACTION: 'Fund Action · 基金行動', REVERSAL: 'Reversal · 沖銷',
  };
  const EVENT_PRIORITY = {
    CAPITAL: 0, LIABILITY: 1, CORPORATE_ACTION: 2, BUY: 3, SELL: 3,
    DIVIDEND: 4, FUND_ACTION: 5, REVERSAL: 6,
  };
  const DERIVED_SHEETS = [
    'Asset Position Record', 'Liability Statement', 'Cash Flow Statement', 'NAV Statement',
  ];
  const INPUT_DEFS = [
    {
      type: 'BUY', sheet: 'ETF Stock Buy Record', visible: 9,
      headers: currency => ['Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity', `Amount (${currency})`, `Buy Price (${currency})`, `Cost Per Share (${currency})`, 'Notes'],
      widths: [9, 14, 9, 40, 10, 13, 14, 18, 42], total: 'trade',
    },
    {
      type: 'SELL', sheet: 'ETF Stock Sell Record', visible: 9,
      headers: currency => ['Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity', `Amount (${currency})`, `Sell Price (${currency})`, `Proceeds Per Share (${currency})`, 'Notes'],
      widths: [9, 14, 9, 40, 10, 13, 14, 20, 42], total: 'trade',
    },
    {
      type: 'DIVIDEND', sheet: 'ETF Stock Dividend Record', visible: 8,
      headers: currency => ['Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity', `Amount (${currency})`, `Div Per Share (${currency})`, 'Notes'],
      widths: [9, 14, 9, 40, 10, 13, 16, 42], total: 'dividend',
    },
    {
      type: 'CORPORATE_ACTION', sheet: 'Corporate Action Record', visible: 10,
      headers: currency => ['Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Type', 'Quantity', 'Post Ticker', 'Post Quantity', `Cash Change (${currency})`, 'Notes'],
      widths: [9, 14, 9, 26, 11, 10, 15, 14, 17, 50], total: 'cash',
    },
    {
      type: 'LIABILITY', sheet: 'Liability Record', visible: 5,
      headers: currency => ['Trade No.', 'Execution Date', `Interest Expense (${currency})`, `Liability Change (${currency})`, 'Notes'],
      widths: [9, 14, 20, 20, 45], total: 'liability',
    },
    {
      type: 'CAPITAL', sheet: 'Capital Record', visible: 8,
      headers: currency => ['Trade No.', 'Execution Date', 'Shareholder', `Subscription (${currency})`, `Redemption (${currency})`, `Unit Price (${currency})`, 'Quantity', 'Notes'],
      widths: [9, 14, 19, 18, 18, 16, 16, 40], total: 'capital',
    },
    {
      type: 'FUND_ACTION', sheet: 'Fund Action Record', visible: 7,
      headers: currency => ['No.', 'Date', 'Type', 'Quantity', 'Post Quantity', `Cash Change (${currency})`, 'Notes'],
      widths: [7, 12, 16, 15, 15, 18, 45], total: 'cash',
    },
  ];
  const INPUT_BY_TYPE = Object.fromEntries(INPUT_DEFS.map(def => [def.type, def]));
  const INPUT_BY_SHEET = Object.fromEntries(INPUT_DEFS.map(def => [def.sheet, def]));
  const META_HEADERS = ['__yi_event_id', '__yi_event_version', '__yi_base_hash', '__yi_payload_json'];
  const FORM_FIELDS = {
    BUY: [
      field('ticker', 'Ticker', 'text', { required: true, placeholder: '例如 NVDA' }),
      field('name', '資產名稱', 'text', { placeholder: '可留空由後台映射' }),
      field('quantity', 'Quantity', 'number', { required: true, min: '0', step: '0.000001' }),
      field('amount', '最終現金 Amount', 'number', { required: true, min: '0', step: '0.01' }),
      field('price', '參考 Buy Price（可留空）', 'number', { min: '0', step: '0.000001' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    SELL: [
      field('ticker', 'Ticker', 'text', { required: true, placeholder: '例如 0700.HK' }),
      field('name', '資產名稱', 'text', { placeholder: '可留空由後台映射' }),
      field('quantity', 'Quantity', 'number', { required: true, min: '0', step: '0.000001' }),
      field('amount', '最終現金 Amount', 'number', { required: true, min: '0', step: '0.01' }),
      field('price', '參考 Sell Price（可留空）', 'number', { min: '0', step: '0.000001' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    DIVIDEND: [
      field('ticker', 'Ticker', 'text', { required: true }),
      field('name', '資產名稱', 'text'),
      field('quantity', 'Quantity', 'number', { required: true, min: '0', step: '0.000001' }),
      field('amount', '最終現金 Amount', 'number', { required: true, min: '0', step: '0.01' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    CORPORATE_ACTION: [
      field('ticker', '原 Ticker', 'text', { required: true }),
      field('name', '資產名稱', 'text'),
      selectField('corporate_action_type', '行動類型', ['SPLIT', 'SPINOFF', 'RENAME', 'MERGER']),
      field('quantity', '行動前 Quantity', 'number', { required: true, min: '0', step: '0.000001' }),
      field('post_ticker', 'Post Ticker', 'text', { required: true, placeholder: '單個或 [SPGI,MBGL]' }),
      field('post_quantity', 'Post Quantity', 'text', { required: true, placeholder: '單個或 [38,38]' }),
      field('cash_change', 'Cash Change', 'number', { step: '0.01' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    LIABILITY: [
      field('interest_expense', 'Interest Expense', 'number', { min: '0', step: '0.01' }),
      field('liability_change', 'Liability Change', 'number', { step: '0.01', placeholder: '借款 + / 還款 −' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    CAPITAL: [
      field('shareholder', 'Shareholder', 'text', { required: true }),
      field('subscription', 'Subscription', 'number', { min: '0', step: '0.01' }),
      field('redemption', 'Redemption', 'number', { min: '0', step: '0.01' }),
      field('unit_price', 'Unit Price', 'number', { required: true, min: '0.000000000001', step: 'any' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
    FUND_ACTION: [
      selectField('fund_action_type', '行動類型', ['MGMT FEE', 'FUND DIVIDEND', 'UNIT SPLIT', 'OTHER']),
      field('quantity', '行動前 Quantity', 'number', { min: '0', step: '0.000001' }),
      field('post_quantity', 'Post Quantity', 'number', { min: '0', step: '0.000001' }),
      field('cash_change', 'Cash Change', 'number', { step: '0.01', placeholder: '費用／派息為負' }),
      field('notes', 'Notes', 'textarea', { full: true }),
    ],
  };

  const state = {
    portfolio: 'us', ledger: null, pending: [], confirmed: [], ledgerRevision: 0,
    dividendCandidates: [], dividendLoadSequence: 0,
    pipelineHealth: null, pipelineView: null,
    importFile: null, importBuffer: null, importHash: null, importParsed: null,
    importPreview: null, importId: null, importExpectedRevision: null,
    importBlockers: [], importBlockerCount: 0,
    legacyPackage: null, legacyPreview: null, legacyImportId: null,
    legacyMigrationHash: null, legacyRequirements: null, legacyConfirmed: false,
  };

  function field(name, label, type, options) {
    return { name, label, type, ...(options || {}) };
  }
  function selectField(name, label, options) {
    return { name, label, type: 'select', options, required: true };
  }
  function el(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function first(object, keys, fallback) {
    for (const key of keys) {
      if (object && object[key] !== undefined && object[key] !== null) return object[key];
    }
    return fallback;
  }
  function asNumber(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback === undefined ? 0 : fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : (fallback === undefined ? 0 : fallback);
  }
  function optionalNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return fallback || {};
    try { return JSON.parse(value); } catch (error) { return fallback || {}; }
  }
  function canonicalType(value) {
    const type = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const aliases = { DIV: 'DIVIDEND', CORP: 'CORPORATE_ACTION', LIA: 'LIABILITY', CAP: 'CAPITAL', FUND: 'FUND_ACTION' };
    return aliases[type] || type;
  }
  function today() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function dateString(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    }
    if (typeof value === 'number' && XLSX_EXPORT && XLSX_EXPORT.SSF) {
      const parsed = XLSX_EXPORT.SSF.parse_date_code(value);
      if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
    const match = String(value).match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  }
  function amountText(value) {
    const number = asNumber(value, NaN);
    if (!Number.isFinite(number)) return String(value === undefined || value === null ? '—' : value);
    return new Intl.NumberFormat('zh-HK', { maximumFractionDigits: 6 }).format(number);
  }
  function revisionNumber(value) {
    const revision = asNumber(value, NaN);
    return Number.isInteger(revision) && revision >= 0 ? revision : null;
  }
  function pipelineReasonText(reason) {
    return ({
      CURRENT_REVISION_RAW_TAPE_MISSING: '正在凍結當前 revision 的 raw-close 價格帶',
      NAV_CALENDAR_COVERAGE_MISSING: '正在補齊交易日 NAV',
      NAV_RECALCULATION_REQUIRED: '現金、持倉與 NAV 正在重算',
      RAW_NAV_COMPLETED_SESSION_STALE: 'NAV 正在追上最新已完成市場日',
      NAV_TARGET_MISMATCH: 'NAV 正在追上價格帶目標日',
      RECALC_NAV_OUTBOX_PENDING: '賬務重算已排隊',
    })[String(reason || '').toUpperCase()] || '派生計算正在進行';
  }
  function pipelineStatusView(health, portfolio, fallbackRevision) {
    const rawPortfolios = first(health, ['raw_nav_portfolios', 'rawNavPortfolios'], {}) || {};
    const storagePortfolios = first(health, ['ledger_storage_portfolios', 'ledgerStoragePortfolios'], {}) || {};
    const raw = rawPortfolios[portfolio] || {};
    const storage = storagePortfolios[portfolio] || {};
    const targetRevision = revisionNumber(first(storage, [
      'targetRevision', 'target_revision', 'ledgerRevision', 'ledger_revision',
    ], first(raw, ['targetRevision', 'target_revision', 'ledgerRevision', 'ledger_revision'], fallbackRevision)))
      ?? revisionNumber(fallbackRevision) ?? 0;
    const projectionRevision = revisionNumber(first(storage, ['projectionRevision', 'projection_revision'], null));
    const publicRevision = revisionNumber(first(storage, ['publicRevision', 'public_revision'], null));
    const explicitComplete = revisionNumber(first(storage, [
      'completedSnapshotRevision', 'completed_snapshot_revision',
      'exportRevision', 'export_revision', 'snapshotRevision', 'snapshot_revision',
    ], null));
    // Excel fallback is backed by the materialized projection, not merely the
    // public-page snapshot. Never advertise a public-only revision as exportable.
    const completedSnapshotRevision = explicitComplete ?? projectionRevision;
    const projectionCurrentValue = first(storage, ['projectionCurrent', 'projection_current'], null);
    const projectionCurrent = targetRevision === 0 && projectionRevision === null ||
      projectionCurrentValue === true ||
      (projectionCurrentValue === null && projectionRevision === targetRevision);
    const publicCurrentValue = first(storage, ['publicCurrent', 'public_current'], null);
    const publicCurrent = publicCurrentValue === true ||
      (publicCurrentValue === null && publicRevision === targetRevision);
    const rawReady = first(raw, ['ready'], false) === true || targetRevision === 0;
    const reason = String(first(raw, ['reason'], '') || '').toUpperCase();
    const tapeThrough = String(first(raw, ['tapeThrough', 'tape_through'], '') || '');
    const latestNavDate = String(first(raw, ['latestNavDate', 'latest_nav_date'], '') || '');
    const priceTapeId = String(first(raw, ['priceTapeId', 'price_tape_id'], '') || '');
    const priceReady = targetRevision === 0 || Boolean(priceTapeId || tapeThrough) &&
      reason !== 'CURRENT_REVISION_RAW_TAPE_MISSING';
    const snapshotCurrent = projectionCurrent;
    const currentReady = rawReady && snapshotCurrent;
    const exportRevision = currentReady ? targetRevision : completedSnapshotRevision;
    const exportReady = exportRevision !== null;
    const stableRevision = completedSnapshotRevision === null ? '尚未生成' : `Revision ${completedSnapshotRevision}`;
    const target = `Revision ${targetRevision}`;
    const publicSuffix = publicRevision !== null && !publicCurrent
      ? `；前台仍穩定服務 Revision ${publicRevision}` : '';

    return {
      targetRevision,
      completedSnapshotRevision,
      exportRevision,
      currentReady,
      exportReady,
      pricing: targetRevision === 0
        ? { state: 'done', title: '無需持倉取價', detail: 'Revision 0 · 現金起始快照' }
        : priceReady
          ? { state: 'done', title: '原始價格已凍結', detail: `${target}${tapeThrough ? ` · raw-close 至 ${tapeThrough}` : ' · raw-close'} · 不復權` }
          : { state: 'active', title: '動態取價中', detail: `${target} · ${pipelineReasonText(reason)}` },
      accounting: rawReady
        ? { state: 'done', title: '賬務重算完成', detail: `${target} · 現金 / 持倉 / NAV 已對齊` }
        : { state: priceReady ? 'active' : 'waiting', title: priceReady ? '動態計算中' : '等待價格帶', detail: `${target} · ${latestNavDate && tapeThrough ? `${latestNavDate} → ${tapeThrough} · ` : ''}${pipelineReasonText(reason)}` },
      snapshot: snapshotCurrent
        ? { state: 'done', title: '完整 Snapshot 已存儲', detail: `${target}${publicSuffix}` }
        : { state: 'active', title: '保留上一完整 Snapshot', detail: `${stableRevision} 穩定可讀；正在生成 ${target}${publicSuffix}` },
      excel: currentReady
        ? { state: 'done', title: 'Snapshot 可導出', detail: `Excel 將導出凍結 Snapshot ${target}` }
        : exportReady
          ? { state: 'done', title: '上一完整 Snapshot 可導出', detail: `Excel 將導出凍結 Snapshot Revision ${exportRevision}；動態 ${target} 仍在計算（可簽名整賬本替換）` }
          : { state: 'waiting', title: '尚無完整 Snapshot', detail: `Excel 不讀取半成品；正在生成 ${target}` },
    };
  }
  function setPipelineStage(id, item) {
    const host = $(id);
    if (!host || !item) return;
    host.dataset.state = item.state;
    const title = host.querySelector('b');
    const detail = host.querySelector('span');
    if (title) title.textContent = item.title;
    if (detail) detail.textContent = item.detail;
  }
  function renderPipelineStatus(view, error) {
    const button = $('export-workbook');
    if (!view) {
      ['pipeline-pricing', 'pipeline-accounting', 'pipeline-snapshot', 'pipeline-excel'].forEach(id => {
        const host = $(id);
        if (!host) return;
        host.dataset.state = 'unknown';
        const title = host.querySelector('b');
        const detail = host.querySelector('span');
        if (title) title.textContent = '狀態暫不可讀';
        if (detail) detail.textContent = String(error && error.message || '可直接嘗試導出，由後台做最終校驗。');
      });
      if (button) { button.disabled = false; button.textContent = '下載 Snapshot Excel'; }
      $('export-revision').textContent = `Ledger Revision ${state.ledgerRevision}`;
      return;
    }
    setPipelineStage('pipeline-pricing', view.pricing);
    setPipelineStage('pipeline-accounting', view.accounting);
    setPipelineStage('pipeline-snapshot', view.snapshot);
    setPipelineStage('pipeline-excel', view.excel);
    if (button) {
      button.disabled = !view.exportReady;
      button.textContent = view.exportReady ? '下載 Snapshot Excel' : '等待完整 Snapshot';
    }
    const complete = view.completedSnapshotRevision === null
      ? '尚無完整 Snapshot'
      : `最後完整 Snapshot Revision ${view.completedSnapshotRevision}`;
    $('export-revision').textContent = view.currentReady
      ? `Snapshot Revision ${view.targetRevision} · 可導出`
      : view.exportReady
        ? `將導出 Snapshot Revision ${view.exportRevision} · 動態 Revision ${view.targetRevision} 計算中`
        : `動態 Revision ${view.targetRevision} · ${complete}`;
  }
  async function loadPipelineStatus() {
    try {
      const health = await api('/api/health');
      state.pipelineHealth = health;
      state.pipelineView = pipelineStatusView(health, state.portfolio, state.ledgerRevision);
      renderPipelineStatus(state.pipelineView);
      return state.pipelineView;
    } catch (error) {
      state.pipelineHealth = null;
      state.pipelineView = null;
      renderPipelineStatus(null, error);
      return null;
    }
  }
  function stableClone(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  function payloadOf(item) {
    const raw = first(item, ['event', 'payload', 'payload_json', 'payloadJson'], null);
    const payload = raw === null ? { ...(item || {}) } : parseJson(raw, {});
    const copy = { ...payload };
    [
      'pendingId', 'pending_id', 'version', 'status', 'source', 'createdAt', 'created_at',
      'updatedAt', 'updated_at', 'event', 'payload', 'payload_json', 'payloadJson', 'raw',
    ].forEach(key => delete copy[key]);
    const type = canonicalType(first(item, ['eventType', 'event_type', 'type'], copy.type));
    const date = dateString(first(item, ['tradeDate', 'trade_date', 'date'], copy.date || copy.trade_date));
    if (type) copy.type = type;
    if (date) copy.date = date;
    return copy;
  }
  function normalizePending(item) {
    const event = payloadOf(item);
    return {
      raw: item,
      pendingId: first(item, ['pendingId', 'pending_id', 'id'], ''),
      version: asNumber(first(item, ['expectedVersion', 'version'], 1), 1),
      status: String(first(item, ['status'], 'PENDING')).toUpperCase(),
      source: String(first(item, ['source'], 'MANUAL')).toUpperCase(),
      createdAt: first(item, ['createdAt', 'created_at'], ''),
      updatedAt: first(item, ['updatedAt', 'updated_at'], ''),
      event,
    };
  }

  function normalizeDividendCandidate(item) {
    const evidence = parseJson(first(item, ['evidence', 'evidence_json', 'evidenceJson'], {}), {});
    const currentQuantity = optionalNumber(first(item, [
      'currentQuantity', 'current_quantity', 'holdingQuantity', 'holding_quantity',
    ], null));
    const suggestedQuantity = optionalNumber(first(item, [
      'suggestedQuantity', 'suggested_quantity', 'quantity',
    ], currentQuantity));
    return {
      raw: item,
      candidateId: String(first(item, ['candidateId', 'candidate_id', 'id'], '') || ''),
      portfolio: String(first(item, ['portfolio', 'portfolio_id'], '') || '').toLowerCase(),
      version: asNumber(first(item, ['expectedVersion', 'version'], 1), 1),
      status: String(first(item, ['status', 'amountStatus', 'amount_status'], 'PENDING_VERIFICATION')).toUpperCase(),
      ticker: String(first(item, ['ticker'], '') || '').toUpperCase(),
      name: String(first(item, ['name', 'securityName', 'security_name'], '') || ''),
      exDate: dateString(first(item, ['exDate', 'ex_date'], '')),
      recordDate: dateString(first(item, ['recordDate', 'record_date'], '')),
      payDate: dateString(first(item, ['payDate', 'pay_date'], '')),
      sourceSystem: String(first(item, ['sourceSystem', 'source_system'], '') || ''),
      sourceEventId: String(first(item, ['sourceEventId', 'source_event_id'], '') || ''),
      detectedAt: first(item, ['detectedAt', 'detected_at'], ''),
      currentQuantity,
      suggestedQuantity,
      evidence,
    };
  }

  function dividendVerifyPayload(candidate, values) {
    const payload = {
      candidateId: candidate.candidateId,
      expectedVersion: candidate.version,
      Amount: String(values.amount || '').trim(),
    };
    const quantity = optionalNumber(values.quantity);
    if (quantity !== null) payload.quantity = quantity;
    const actualReceiptDate = dateString(values.actualReceiptDate);
    const recordDate = dateString(values.recordDate);
    const reviewNote = String(values.reviewNote || '').trim();
    if (actualReceiptDate) payload.actualReceiptDate = actualReceiptDate;
    if (recordDate) payload.recordDate = recordDate;
    if (reviewNote) payload.reviewNote = reviewNote;
    return payload;
  }

  function dividendDismissPayload(candidate, reason) {
    return {
      candidateId: candidate.candidateId,
      expectedVersion: candidate.version,
      reason: String(reason || '').trim(),
    };
  }

  function dividendEvidenceEntries(candidate) {
    const rows = [
      ['source_system', candidate.sourceSystem],
      ['source_event_id', candidate.sourceEventId],
    ];
    function walk(value, prefix, depth) {
      if (!value || typeof value !== 'object' || depth > 2) return;
      Object.keys(value).sort().forEach(key => {
        const nested = value[key];
        const label = prefix ? `${prefix}.${key}` : key;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) walk(nested, label, depth + 1);
        else if (nested !== null && nested !== undefined && nested !== '') {
          rows.push([label, Array.isArray(nested) ? JSON.stringify(nested) : String(nested)]);
        }
      });
    }
    walk(candidate.evidence, '', 0);
    return rows.filter((row, index) => row[1] && rows.findIndex(other => other[0] === row[0] && other[1] === row[1]) === index).slice(0, 16);
  }

  function mountLedgerNavLink() {
    const nav = $('adminnav');
    if (!nav || nav.querySelector('[href="admin-ledger"]')) return;
    const link = el('a', 'on', '投資組合賬本');
    link.href = 'admin-ledger';
    const exit = nav.querySelector('.exit');
    nav.insertBefore(link, exit || null);
  }

  function bind() {
    $('trade-date').value = today();
    document.querySelectorAll('#portfolio-tabs button').forEach(button => {
      button.addEventListener('click', () => switchPortfolio(button.dataset.portfolio));
    });
    $('refresh-ledger').addEventListener('click', loadLedger);
    $('event-type').addEventListener('change', renderEventFields);
    $('event-form').addEventListener('submit', savePending);
    $('reset-event').addEventListener('click', resetForm);
    $('export-workbook').addEventListener('click', exportWorkbook);
    $('rebuild-derived').addEventListener('click', rebuildDerived);
    $('drain-outbox').addEventListener('click', drainPortfolioOutbox);
    $('import-file').addEventListener('change', event => prepareImport(event.target.files && event.target.files[0]));
    $('preview-import').addEventListener('click', previewImport);
    $('import-replace-all-ack').addEventListener('change', updateImportConfirmation);
    $('import-confirm-reason').addEventListener('input', updateImportConfirmation);
    $('confirm-import').addEventListener('click', confirmImport);
    $('legacy-json').addEventListener('input', invalidateLegacyPackage);
    $('parse-legacy').addEventListener('click', parseLegacyMigrationPackage);
    $('clear-legacy').addEventListener('click', () => clearLegacyMigration());
    $('preview-legacy').addEventListener('click', previewLegacyMigration);
    $('legacy-confirm-phrase').addEventListener('input', updateLegacyConfirmation);
    LEGACY_ACKS.forEach(item => $(item.input).addEventListener('change', updateLegacyConfirmation));
    $('confirm-legacy').addEventListener('click', confirmLegacyMigration);
    $('drain-legacy-outbox').addEventListener('click', drainLegacyOutbox);
    renderEventFields();
  }

  async function switchPortfolio(portfolio) {
    if (!PORTFOLIOS[portfolio] || portfolio === state.portfolio) return;
    state.portfolio = portfolio;
    document.querySelectorAll('#portfolio-tabs button').forEach(button => button.classList.toggle('on', button.dataset.portfolio === portfolio));
    resetForm();
    clearImport();
    clearLegacyMigration();
    await loadLedger();
  }

  function renderSummary() {
    const host = $('ledger-summary');
    host.replaceChildren();
    const stats = [
      ['PENDING · 待確認', state.pending.filter(item => item.status === 'PENDING').length],
      ['CONFIRMED · 已入賬', state.confirmed.length],
      ['LEDGER REVISION', state.ledgerRevision],
      ['PORTFOLIO', `${state.portfolio.toUpperCase()} · ${PORTFOLIOS[state.portfolio].currency}`],
    ];
    for (const [label, value] of stats) {
      const card = el('div', 'ledger-stat');
      card.append(el('b', '', value), el('span', '', label));
      host.append(card);
    }
  }

  async function loadLedger() {
    const host = $('pending-list');
    host.replaceChildren(el('div', 'empty-state', '載入中…'));
    $('refresh-ledger').disabled = true;
    const dividendLoad = loadDividendCandidates();
    let loadError = null;
    try {
      const result = await api(`/api/admin/ledger?portfolio=${encodeURIComponent(state.portfolio)}&status=all`);
      state.ledger = result;
      state.ledgerRevision = asNumber(first(result, ['ledgerRevision', 'ledger_revision', 'revision'], 0), 0);
      const pendingRaw = first(result, ['pending', 'pendingEvents', 'pending_events', 'items'], []);
      const eventsRaw = first(result, ['events', 'confirmedEvents', 'confirmed_events'], []);
      state.pending = (Array.isArray(pendingRaw) ? pendingRaw : []).map(normalizePending).filter(item => item.status === 'PENDING');
      state.confirmed = (Array.isArray(eventsRaw) ? eventsRaw : []).filter(item => String(first(item, ['status'], 'CONFIRMED')).toUpperCase() !== 'PENDING');
      renderSummary();
      renderPending();
    } catch (error) {
      loadError = error;
    } finally {
      const [pipeline] = await Promise.all([loadPipelineStatus(), dividendLoad]);
      if (loadError) {
        const message = pipeline && !pipeline.currentReady
          ? `↻ 動態 Revision ${pipeline.targetRevision} 正在處理；事件沒有丟失。請等四個階段完成後刷新。`
          : '✗ ' + loadError.message;
        host.replaceChildren(el('div', pipeline && !pipeline.currentReady ? 'log' : 'log err', message));
      }
      $('refresh-ledger').disabled = false;
    }
  }

  async function loadDividendCandidates() {
    const portfolio = state.portfolio;
    const sequence = ++state.dividendLoadSequence;
    const host = $('dividend-inbox-list');
    const count = $('dividend-inbox-count');
    const status = $('dividend-inbox-status');
    host.replaceChildren(el('div', 'empty-state', `正在讀取 ${portfolio.toUpperCase()} 派息候選…`));
    count.textContent = '讀取中…';
    status.textContent = '來源候選只提供派息存在性與日期證據，不提供 Amount。';
    try {
      const result = await api(`/api/admin/ledger/dividends?portfolio=${encodeURIComponent(portfolio)}&status=PENDING_VERIFICATION`);
      if (sequence !== state.dividendLoadSequence || portfolio !== state.portfolio) return;
      const responsePortfolio = String(first(result, ['portfolio'], portfolio)).toLowerCase();
      if (responsePortfolio !== portfolio) throw new Error('後端返回了錯誤的投資組合派息候選。');
      const raw = first(result, ['candidates', 'items'], []);
      state.dividendCandidates = (Array.isArray(raw) ? raw : [])
        .map(normalizeDividendCandidate)
        .filter(item => item.status === 'PENDING_VERIFICATION' || item.status === 'PENDING');
      count.textContent = `${state.dividendCandidates.length} 待核實`;
      status.textContent = state.dividendCandidates.length
        ? '請用券商結單核對最終到賬 Amount；每筆操作均保留來源與版本審計。'
        : '目前沒有待核實派息候選。';
      renderDividendCandidates();
    } catch (error) {
      if (sequence !== state.dividendLoadSequence || portfolio !== state.portfolio) return;
      state.dividendCandidates = [];
      count.textContent = '讀取失敗';
      status.textContent = '✗ ' + error.message;
      host.replaceChildren(el('div', 'log err', '派息候選讀取失敗；賬本 Pending 不受影響，可稍後刷新。'));
    }
  }

  function renderDividendCandidates() {
    const host = $('dividend-inbox-list');
    host.replaceChildren();
    if (!state.dividendCandidates.length) {
      host.append(el('div', 'empty-state', '目前沒有待核實派息候選。'));
      return;
    }
    state.dividendCandidates
      .slice()
      .sort((a, b) => String(b.payDate || b.exDate).localeCompare(String(a.payDate || a.exDate)) || a.candidateId.localeCompare(b.candidateId))
      .forEach(candidate => host.append(dividendCandidateCard(candidate)));
  }

  function dividendCandidateCard(candidate) {
    const card = el('article', 'ledger-card dividend-candidate');
    const head = el('div', 'ledger-head');
    const title = el('div', 'ledger-title');
    title.append(
      el('span', 'ledger-pill pending', 'AWAITING AMOUNT'),
      el('span', 'ledger-pill', candidate.ticker || 'UNKNOWN'),
      el('strong', '', candidate.name || candidate.ticker || '未命名資產'),
    );
    head.append(title, el('span', 'ledger-meta', `Candidate v${candidate.version}`));

    const dates = el('div', 'ledger-payload');
    [
      ['EX DATE', candidate.exDate || '—'],
      ['RECORD DATE', candidate.recordDate || '—'],
      ['PAY DATE', candidate.payDate || '—'],
      ['CURRENT QUANTITY', candidate.currentQuantity === null ? '沒有可靠建議，必須手填' : amountText(candidate.currentQuantity)],
    ].forEach(([key, value]) => {
      const cell = el('div', 'ledger-kv');
      cell.append(el('small', '', key), el('span', '', value));
      dates.append(cell);
    });

    const evidence = document.createElement('details');
    evidence.className = 'dividend-evidence';
    const evidenceSummary = document.createElement('summary');
    evidenceSummary.textContent = `來源證據 · ${candidate.sourceSystem || 'UNKNOWN SOURCE'}`;
    const evidenceGrid = el('div', 'dividend-evidence-grid');
    dividendEvidenceEntries(candidate).forEach(([key, value]) => {
      const row = el('div', 'dividend-evidence-row');
      row.append(el('small', '', key));
      if (/^https?:\/\//i.test(value)) {
        const link = el('a', '', value);
        link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer';
        row.append(link);
      } else row.append(el('span', '', value));
      evidenceGrid.append(row);
    });
    evidence.append(evidenceSummary, evidenceGrid);

    const review = el('div', 'dividend-review-form');
    const fields = el('div', 'dividend-review-grid');
    const amount = dividendInput('number', `券商最終到賬 Amount (${PORTFOLIOS[state.portfolio].currency})`, {
      required: true, min: '0.01', step: '0.01', placeholder: '必填，例如 123.45', inputMode: 'decimal',
    });
    amount.wrap.append(el('div', 'dividend-amount-note', '唯一現金輸入：券商最終實際到賬，已含所有預扣稅與費用。'));
    const quantity = dividendInput('number', 'Quantity（必須核實，可修改）', {
      required: true, min: '0.000001', step: '0.000001', placeholder: '必填：按券商派息明細核實', inputMode: 'decimal',
      value: candidate.suggestedQuantity === null ? '' : candidate.suggestedQuantity,
    });
    const receiptDate = dividendInput('date', '實際到賬日期（可修改）', {
      value: candidate.payDate || candidate.exDate || '',
    });
    const recordDate = dividendInput('date', 'Record Date（可修改）', {
      value: candidate.recordDate || '',
    });
    const reviewNote = dividendInput('text', '核實備註（可選）', {
      placeholder: '例如：已核對券商結單', maxLength: 1000,
    });
    reviewNote.wrap.classList.add('full');
    fields.append(amount.wrap, quantity.wrap, receiptDate.wrap, recordDate.wrap, reviewNote.wrap);

    const status = el('span', 'form-state', '核實只轉入 Automation Pending，不會自動 Confirm。');
    status.setAttribute('role', 'status');
    const verify = el('button', 'btn', '核實並轉入 Automation Pending');
    verify.type = 'button';
    const dismissReason = document.createElement('input');
    dismissReason.type = 'text'; dismissReason.maxLength = 1000;
    dismissReason.placeholder = '忽略理由（按忽略時必填）';
    dismissReason.setAttribute('aria-label', '忽略派息候選理由');
    const dismiss = el('button', 'danger-solid', '忽略候選');
    dismiss.type = 'button';
    const dismissRow = el('div', 'dividend-dismiss');
    dismissRow.append(dismissReason, dismiss);
    const controls = [amount.input, quantity.input, receiptDate.input, recordDate.input, reviewNote.input, dismissReason, verify, dismiss];
    verify.addEventListener('click', () => verifyDividend(candidate, {
      amount: amount.input, quantity: quantity.input, actualReceiptDate: receiptDate.input,
      recordDate: recordDate.input, reviewNote: reviewNote.input,
    }, controls, status));
    dismiss.addEventListener('click', () => dismissDividend(candidate, dismissReason, controls, status));
    review.append(fields, verify, dismissRow, status);
    card.append(head, dates, evidence, review);
    return card;
  }

  function dividendInput(type, labelText, attributes) {
    const wrap = el('label', 'ledger-field');
    const label = el('span', '', labelText);
    const input = document.createElement('input');
    input.type = type;
    Object.entries(attributes || {}).forEach(([key, value]) => {
      if (key === 'required') input.required = Boolean(value);
      else if (key === 'inputMode') input.inputMode = value;
      else if (key === 'maxLength') input.maxLength = value;
      else input[key] = value;
    });
    wrap.append(label, input);
    return { wrap, input };
  }

  function setDividendControlsBusy(controls, busy) {
    controls.forEach(control => { control.disabled = busy; });
  }

  async function verifyDividend(candidate, inputs, controls, status) {
    const amount = String(inputs.amount.value || '').trim();
    const quantity = String(inputs.quantity.value || '').trim();
    if (!(Number(amount) > 0)) {
      status.textContent = '✗ Amount 必須填寫券商最終到賬正數。';
      inputs.amount.focus();
      return;
    }
    if (!(Number(quantity) > 0)) {
      status.textContent = '✗ Quantity 必須按券商派息明細核實並填寫大於 0 的數值。';
      inputs.quantity.focus();
      return;
    }
    const payload = dividendVerifyPayload(candidate, {
      amount,
      quantity,
      actualReceiptDate: inputs.actualReceiptDate.value,
      recordDate: inputs.recordDate.value,
      reviewNote: inputs.reviewNote.value,
    });
    setDividendControlsBusy(controls, true);
    status.textContent = '正在核實來源版本並建立 Automation Pending…';
    try {
      const result = await api('/api/admin/ledger/dividends/verify', {
        method: 'POST', body: JSON.stringify(payload),
      });
      const pending = first(result, ['pending'], {}) || {};
      const pendingId = first(pending, ['pendingId', 'pending_id'], '—');
      status.textContent = `✓ 已建立 Automation Pending ${pendingId}；尚未 Confirm、尚未正式入賬。`;
      await loadLedger();
    } catch (error) {
      status.textContent = '✗ ' + error.message;
      setDividendControlsBusy(controls, false);
    }
  }

  async function dismissDividend(candidate, reasonInput, controls, status) {
    const payload = dividendDismissPayload(candidate, reasonInput.value);
    if (!payload.reason) {
      status.textContent = '✗ 忽略候選必須填寫理由。';
      reasonInput.focus();
      return;
    }
    setDividendControlsBusy(controls, true);
    status.textContent = '正在保存忽略理由…';
    try {
      await api('/api/admin/ledger/dividends/dismiss', {
        method: 'POST', body: JSON.stringify(payload),
      });
      status.textContent = '✓ 候選已忽略；未建立 Pending、未修改正式賬本。';
      await loadLedger();
    } catch (error) {
      status.textContent = '✗ ' + error.message;
      setDividendControlsBusy(controls, false);
    }
  }

  async function rebuildDerived() {
    const button = $('rebuild-derived');
    const reason = String($('rebuild-reason').value || '').trim();
    const log = $('rebuild-log');
    if (!reason) {
      log.textContent = '✗ 請填寫重算原因。';
      $('rebuild-reason').focus();
      return;
    }
    button.disabled = true;
    log.textContent = '正在排隊 REBUILD_KV → RECALC_NAV → REBUILD_EXCEL…';
    try {
      const result = await api('/api/admin/ledger/rebuild', {
        method: 'POST',
        body: JSON.stringify({ portfolio: state.portfolio, reason }),
      });
      const revision = asNumber(first(result, ['ledgerRevision', 'ledger_revision'], state.ledgerRevision), state.ledgerRevision);
      const affectedFrom = first(result, ['affectedFrom', 'affected_from'], '—');
      log.textContent = `✓ 已排隊 ${state.portfolio.toUpperCase()} revision ${revision} · from ${affectedFrom}。後台會按批次自動完成。`;
      await loadPipelineStatus();
    } catch (error) {
      log.textContent = '✗ 重算排隊失敗：' + error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function drainPortfolioOutbox() {
    const portfolio = state.portfolio;
    const button = $('drain-outbox');
    const status = $('drain-outbox-state');
    const log = $('rebuild-log');
    button.disabled = true;
    status.textContent = `正在續跑 ${portfolio.toUpperCase()} 目前的重算進度…`;
    log.textContent = '正在處理 REBUILD_KV / RECALC_NAV / REBUILD_EXCEL…';
    try {
      const result = await api('/api/admin/ledger/outbox', {
        method: 'POST', body: JSON.stringify({ portfolio }),
      });
      const rows = Array.isArray(result.results) ? result.results : [];
      const failed = rows.filter(item => item && item.ok === false);
      const continuation = rows.find(item => item && item.complete === false && item.ok !== false);
      const pending = result.pending === true || Boolean(continuation);
      const processed = asNumber(first(result, ['processed'], rows.length), rows.length);
      const remaining = asNumber(first(result, ['remaining'], pending ? 1 : 0), pending ? 1 : 0);
      if (failed.length) {
        const detail = String(first(failed[0], ['error'], '請稍後重試')).slice(0, 240);
        log.textContent = `✗ ${portfolio.toUpperCase()} 隊列已處理 ${processed} 項，其中 ${failed.length} 項失敗：${detail}`;
      } else if (pending) {
        const nextPhase = String(first(continuation || {}, ['nextPhase', 'phase'], '等待下一批'));
        const batchThrough = String(first(continuation || {}, ['batchThrough'], ''));
        log.textContent = `↻ ${portfolio.toUpperCase()} 本批已完成 · processed ${processed} · remaining ${remaining} · 下一階段 ${nextPhase}${batchThrough ? `（已到 ${batchThrough}）` : ''}。`;
      } else {
        log.textContent = `✓ ${portfolio.toUpperCase()} 隊列處理完成 · processed ${processed}${processed === 0 ? '（目前沒有待處理項）' : ''}。`;
      }
      status.textContent = failed.length
        ? '本批有錯誤；保留 checkpoint，可按鈕重試。'
        : pending ? '本批完成；可再次繼續，直到 remaining 變成 0。' : '目前隊列已清空。';
      await loadLedger();
    } catch (error) {
      log.textContent = `✗ ${portfolio.toUpperCase()} 隊列處理失敗：${error.message}`;
      status.textContent = 'checkpoint 未重置；可稍後重試。';
    } finally {
      button.disabled = false;
    }
  }

  function renderPending() {
    const host = $('pending-list');
    host.replaceChildren();
    if (!state.pending.length) {
      host.append(el('div', 'empty-state', '目前沒有待確認事件。'));
      return;
    }
    state.pending
      .slice()
      .sort((a, b) => String(a.event.date || '').localeCompare(String(b.event.date || '')) || a.pendingId.localeCompare(b.pendingId))
      .forEach(item => host.append(pendingCard(item)));
  }

  function pendingCard(item) {
    const card = el('article', 'ledger-card');
    const head = el('div', 'ledger-head');
    const title = el('div', 'ledger-title');
    const type = canonicalType(item.event.type);
    title.append(
      el('span', 'ledger-pill pending', 'PENDING'),
      el('span', 'ledger-pill', EVENT_LABELS[type] || type || 'UNKNOWN'),
      el('span', 'ledger-pill', item.source)
    );
    const metaTop = el('span', 'ledger-meta', `${item.event.date || '—'} · v${item.version}`);
    head.append(title, metaTop);
    const meta = el('div', 'ledger-meta', `Pending ID：${item.pendingId || '—'}${item.updatedAt ? ` · Updated ${item.updatedAt}` : ''}`);
    const payload = el('div', 'ledger-payload');
    displayPayload(item.event).forEach(([key, value]) => {
      const cell = el('div', 'ledger-kv');
      cell.append(el('small', '', key), el('span', '', value));
      payload.append(cell);
    });

    const actions = el('div', 'ledger-actions');
    const edit = el('button', 'btn2', '修改'); edit.type = 'button';
    edit.addEventListener('click', () => editPending(item));
    const review = el('div', 'ledger-review');
    const reason = document.createElement('input');
    reason.type = 'text'; reason.placeholder = '確認／驳回理由（必填）'; reason.setAttribute('aria-label', '確認或驳回理由');
    const cashRule = el('span', 'ledger-meta', '負現金照實進入現金與淨值計算，不報警、不改寫、不阻斷。');
    review.append(reason, cashRule);
    const confirm = el('button', 'btn', '確認入賬'); confirm.type = 'button';
    const reject = el('button', 'danger-solid', '驳回'); reject.type = 'button';
    const status = el('span', 'form-state', ''); status.setAttribute('role', 'status');
    confirm.addEventListener('click', () => confirmPending(item, reason, confirm, reject, status));
    reject.addEventListener('click', () => rejectPending(item, reason, confirm, reject, status));
    actions.append(edit, review, confirm, reject, status);
    card.append(head, meta, payload, actions);
    return card;
  }

  function displayPayload(event) {
    const omitted = new Set([
      'type', 'date', 'schema_version', 'event_id', 'status', 'source', 'payload',
      'gross_amount', 'gross_amount_decimal', 'gross_amount_minor', 'gross_amount_inferred',
      'withholding_tax', 'withholding_tax_decimal', 'withholding_tax_minor',
      'transaction_tax', 'transaction_tax_decimal', 'transaction_tax_minor',
      'tax_amount', 'tax_amount_decimal', 'tax_amount_minor', 'tax_rate', 'tax_mode',
      'fees', 'fees_decimal', 'fees_minor', 'fee_amount', 'fee_amount_decimal', 'fee_amount_minor',
      'tax_status', 'tax_review_required', 'tax_review_reason',
    ]);
    const preferred = [
      'ticker', 'name', 'quantity', 'amount', 'price', 'shareholder', 'subscription', 'redemption',
      'unit_price', 'corporate_action_type', 'post_ticker', 'post_quantity', 'interest_expense',
      'liability_change', 'fund_action_type', 'cash_change', 'net_amount', 'notes',
    ];
    const keys = [...preferred.filter(key => event[key] !== undefined && event[key] !== null && event[key] !== ''),
      ...Object.keys(event).filter(key => !preferred.includes(key) && !omitted.has(key) && event[key] !== undefined && event[key] !== null && event[key] !== '')];
    return keys.slice(0, 15).map(key => [key, typeof event[key] === 'object' ? JSON.stringify(event[key]) : amountText(event[key])]);
  }

  function renderEventFields() {
    const type = canonicalType($('event-type').value);
    const host = $('event-fields-grid');
    host.replaceChildren();
    (FORM_FIELDS[type] || []).forEach(def => {
      const wrap = el('div', 'ledger-field' + (def.full ? ' full' : ''));
      const label = document.createElement('label');
      label.htmlFor = 'ef-' + def.name; label.textContent = def.label;
      let input;
      if (def.type === 'textarea') {
        input = document.createElement('textarea');
      } else if (def.type === 'select') {
        input = document.createElement('select');
        def.options.forEach(value => {
          const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option);
        });
      } else {
        input = document.createElement('input'); input.type = def.type;
      }
      input.id = 'ef-' + def.name;
      input.dataset.eventField = def.name;
      if (def.required) input.required = true;
      ['min', 'max', 'step', 'placeholder'].forEach(key => { if (def[key] !== undefined) input[key] = def[key]; });
      wrap.append(label, input); host.append(wrap);
    });
  }

  function collectFormFields() {
    const event = {};
    document.querySelectorAll('[data-event-field]').forEach(input => {
      let value = input.value.trim();
      if (input.type === 'number') value = optionalNumber(value);
      if (value !== '' && value !== null) event[input.dataset.eventField] = value;
    });
    return event;
  }

  function buildEvent() {
    if (!$('event-form').reportValidity()) return null;
    const type = canonicalType($('event-type').value);
    const date = $('trade-date').value;
    const fields = collectFormFields();
    if (!date) throw new Error('請填寫交易日期。');
    if (type === 'CAPITAL') {
      const subscription = asNumber(fields.subscription, 0);
      const redemption = asNumber(fields.redemption, 0);
      if ((subscription > 0) === (redemption > 0)) throw new Error('Subscription 和 Redemption 必須只填一項。');
      if (asNumber(fields.unit_price, 0) <= 0) throw new Error('Unit Price 必須大於 0。');
    }
    if (['BUY', 'SELL', 'DIVIDEND'].includes(type)) {
      if (asNumber(fields.quantity, 0) <= 0 || asNumber(fields.amount, 0) <= 0) throw new Error('Quantity 和 Amount 必須大於 0。');
      fields.ticker = String(fields.ticker || '').trim().toUpperCase();
    }
    if (type === 'CORPORATE_ACTION') fields.ticker = String(fields.ticker || '').trim().toUpperCase();
    return { schema_version: 1, type, date, ...fields };
  }

  async function savePending(event) {
    event.preventDefault();
    const status = $('form-status');
    const button = $('save-event');
    button.disabled = true; status.textContent = '保存中…';
    try {
      const ledgerEvent = buildEvent();
      if (!ledgerEvent) return;
      const pendingId = $('edit-pending-id').value;
      const version = asNumber($('edit-version').value, 0);
      if (pendingId) {
        await api('/api/admin/ledger/pending/update', {
          method: 'POST', body: JSON.stringify({ pendingId, expectedVersion: version, event: ledgerEvent }),
        });
        status.textContent = '✓ Pending 已更新';
      } else {
        const idempotencyKey = await sha256Text(`${state.portfolio}|MANUAL|${stableStringify(ledgerEvent)}`);
        await api('/api/admin/ledger/pending', {
          method: 'POST', body: JSON.stringify({ portfolio: state.portfolio, event: ledgerEvent, idempotencyKey }),
        });
        status.textContent = '✓ 已加入 Pending';
      }
      resetForm(false);
      await loadLedger();
    } catch (error) {
      status.textContent = '✗ ' + error.message;
    } finally {
      button.disabled = false;
    }
  }

  function editPending(item) {
    const event = item.event;
    const type = canonicalType(event.type);
    if (!FORM_FIELDS[type]) return;
    $('edit-pending-id').value = item.pendingId;
    $('edit-version').value = item.version;
    $('event-type').value = type;
    $('event-type').disabled = true;
    $('trade-date').value = dateString(event.date) || today();
    renderEventFields();
    (FORM_FIELDS[type] || []).forEach(def => {
      const input = $('ef-' + def.name);
      const value = first(event, fieldAliases(def.name), '');
      if (input) input.value = value === null || value === undefined ? '' : String(value);
    });
    $('form-title').textContent = '修改 Pending 事件';
    $('form-mode').textContent = `${item.pendingId} · v${item.version}`;
    $('save-event').textContent = '保存修改';
    $('form-status').textContent = '';
    $('event-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function fieldAliases(name) {
    const camel = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    const aliases = [name, camel];
    if (name === 'corporate_action_type') aliases.push('action_type', 'actionType');
    if (name === 'fund_action_type') aliases.push('action_type', 'actionType');
    if (name === 'post_ticker') aliases.push('postTicker');
    if (name === 'post_quantity') aliases.push('postQty', 'postQuantity');
    if (name === 'unit_price') aliases.push('unitPrice');
    if (name === 'amount') aliases.push('net_amount', 'netAmount', 'operational_amount', 'operationalAmount');
    return aliases;
  }

  function resetForm(clearStatus) {
    $('event-form').reset();
    $('edit-pending-id').value = '';
    $('edit-version').value = '';
    $('trade-date').value = today();
    $('event-type').disabled = false;
    $('form-title').textContent = '新增 Pending 事件';
    $('form-mode').textContent = 'MANUAL';
    $('save-event').textContent = '加入 Pending';
    if (clearStatus !== false) $('form-status').textContent = '';
    renderEventFields();
  }

  async function confirmPending(item, reasonInput, confirmButton, rejectButton, status) {
    const reason = reasonInput.value.trim();
    if (!reason) { status.textContent = '請先填寫確認理由。'; reasonInput.focus(); return; }
    confirmButton.disabled = rejectButton.disabled = true; status.textContent = '確認中…';
    try {
      await api('/api/admin/ledger/pending/confirm', {
        method: 'POST',
        body: JSON.stringify({ pendingId: item.pendingId, expectedVersion: item.version, confirmation: { reason } }),
      });
      status.textContent = '✓ 已確認入賬'; await loadLedger();
    } catch (error) {
      status.textContent = '✗ ' + error.message;
      confirmButton.disabled = rejectButton.disabled = false;
    }
  }

  async function rejectPending(item, reasonInput, confirmButton, rejectButton, status) {
    const reason = reasonInput.value.trim();
    if (!reason) { status.textContent = '請先填寫驳回理由。'; reasonInput.focus(); return; }
    confirmButton.disabled = rejectButton.disabled = true; status.textContent = '驳回中…';
    try {
      await api('/api/admin/ledger/pending/reject', {
        method: 'POST', body: JSON.stringify({ pendingId: item.pendingId, expectedVersion: item.version, reason }),
      });
      status.textContent = '✓ 已驳回'; await loadLedger();
    } catch (error) {
      status.textContent = '✗ ' + error.message;
      confirmButton.disabled = rejectButton.disabled = false;
    }
  }

  async function ensureXLSX() {
    if (XLSX_EXPORT) return XLSX_EXPORT;
    throw new Error('本地 Excel 導出庫加載失敗，已停止導出。');
  }

  async function sha256Buffer(buffer) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('瀏覽器不支援安全 SHA-256，已停止上傳。');
    const hash = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function sha256Text(text) {
    return sha256Buffer(new TextEncoder().encode(text));
  }

  function xmlElementPattern(tag) {
    return new RegExp(`<${tag}(?:\\s[^>]*)?\\s*\\/>|<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`);
  }

  function graftTemplateXmlElement(targetXml, templateXml, tag, beforeTags, closingTag) {
    const templateNode = templateXml.match(xmlElementPattern(tag));
    if (!templateNode) return targetXml;
    const targetPattern = xmlElementPattern(tag);
    if (targetPattern.test(targetXml)) return targetXml.replace(targetPattern, templateNode[0]);
    let insertion = -1;
    (beforeTags || []).forEach(anchor => {
      const index = targetXml.search(new RegExp(`<${anchor}(?:\\s|>)`));
      if (index >= 0 && (insertion < 0 || index < insertion)) insertion = index;
    });
    if (insertion < 0) insertion = targetXml.indexOf(closingTag);
    if (insertion < 0) throw new Error(`工作簿 XML 缺少 ${tag} 的安全插入點。`);
    return targetXml.slice(0, insertion) + templateNode[0] + targetXml.slice(insertion);
  }

  function cellStyleCount(stylesXml) {
    const match = String(stylesXml || '').match(/<cellXfs\b[^>]*\bcount="(\d+)"/);
    return match ? Number(match[1]) : 0;
  }

  const LOCKED_TEMPLATE_STYLES_SHA256 =
    '069f6e5cda9839dc4d15a1fc07ee1967c7cf911c98faa71a77f9ca96580b9c5b';

  function canonicalStyleManifest(workbook) {
    const manifest = Object.create(null);
    workbook.SheetNames.forEach((name, index) => {
      const styles = Object.create(null);
      const sheet = workbook.Sheets[name] || {};
      Object.keys(sheet).forEach(address => {
        if (address.startsWith('!')) return;
        const styleId = sheet[address] && sheet[address].__yiCanonicalStyleId;
        styles[address] = Number.isInteger(styleId) ? styleId : 0;
      });
      manifest[`xl/worksheets/sheet${index + 1}.xml`] = styles;
    });
    return manifest;
  }

  function remapGeneratedCellStyles(sheetXml, canonicalStyles, templateStyleCount, part) {
    const expected = canonicalStyles || {};
    const seen = new Set();
    let cellCount = 0;
    const remapped = sheetXml.replace(/<c\b[^>]*>/g, openingTag => {
      const address = openingTag.match(/\br="([^"]+)"/);
      if (!address) throw new Error(`${part} 出現無座標單元格，已停止導出。`);
      cellCount += 1;
      const reference = address[1];
      const hasCanonicalStyle = Object.prototype.hasOwnProperty.call(expected, reference);
      if (!hasCanonicalStyle) {
        throw new Error(`${part} 的 ${reference} 缺少鎖定樣式，已停止導出。`);
      }
      const templateStyleId = Number(expected[reference]);
      if (!Number.isInteger(templateStyleId) || templateStyleId < 0 ||
          templateStyleId >= templateStyleCount) {
        throw new Error(`${part} 的 ${reference} 出現未鎖定樣式 ${templateStyleId}，已停止導出。`);
      }
      seen.add(reference);
      const withoutStyle = openingTag.replace(/\s+s="\d+"/, '');
      const selfClosing = /\/>$/.test(withoutStyle);
      const tagBody = withoutStyle.replace(/\/?>$/, '');
      return `${tagBody} s="${templateStyleId}"${selfClosing ? '/>' : '>'}`;
    });
    if (!cellCount) throw new Error(`${part} 沒有可驗證單元格，已停止導出。`);
    const missing = Object.keys(expected).filter(reference => !seen.has(reference));
    if (missing.length) {
      throw new Error(`${part} 缺少 ${missing[0]} 等鎖定樣式單元格，已停止導出。`);
    }
    return remapped;
  }

  function trustedTemplateArchive(templateBuffer) {
    if (!XLSX_EXPORT.CFB || typeof XLSX_EXPORT.CFB.read !== 'function' || typeof XLSX_EXPORT.CFB.find !== 'function') {
      throw new Error('表格庫缺少可信模板版式讀取能力，已停止導出。');
    }
    // SECURITY: this helper is only for the bundled same-origin export template.
    // Never pass user-selected files here and never use the SheetJS workbook parser.
    return XLSX_EXPORT.CFB.read(new Uint8Array(templateBuffer), { type: 'array' });
  }

  function trustedTemplateXml(archive, part) {
    const entry = XLSX_EXPORT.CFB.find(archive, `Root Entry/${part}`);
    if (!entry || !entry.content) throw new Error(`工作簿模板缺少 ${part}。`);
    const xml = new TextDecoder().decode(entry.content);
    const documentNode = new DOMParser().parseFromString(xml, 'application/xml');
    if (documentNode.getElementsByTagName('parsererror').length) {
      throw new Error(`工作簿模板 ${part} 不是有效 XML。`);
    }
    return documentNode;
  }

  function templateElements(documentNode, localName) {
    return [...documentNode.getElementsByTagName('*')]
      .filter(node => node.localName === localName);
  }

  function trustedTemplateSheetLayout(archive, sheetIndex) {
    const documentNode = trustedTemplateXml(archive, `xl/worksheets/sheet${sheetIndex}.xml`);
    const columns = [];
    templateElements(documentNode, 'col').forEach(node => {
      const min = Number.parseInt(node.getAttribute('min') || '', 10);
      const max = Number.parseInt(node.getAttribute('max') || '', 10);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 16384) {
        throw new Error('工作簿模板包含無效欄位版式。');
      }
      const width = Number(node.getAttribute('width'));
      for (let index = min - 1; index < max; index += 1) {
        const column = {};
        if (Number.isFinite(width) && width > 0) column.width = width;
        if (node.getAttribute('hidden') === '1') column.hidden = true;
        const level = Number.parseInt(node.getAttribute('outlineLevel') || '', 10);
        if (Number.isInteger(level) && level >= 0) column.level = level;
        columns[index] = column;
      }
    });
    const rows = [];
    templateElements(documentNode, 'row').forEach(node => {
      const number = Number.parseInt(node.getAttribute('r') || '', 10);
      if (!Number.isInteger(number) || number < 1 || number > 1048576) return;
      const row = {};
      const height = Number(node.getAttribute('ht'));
      if (Number.isFinite(height) && height > 0) row.hpt = height;
      if (node.getAttribute('hidden') === '1') row.hidden = true;
      rows[number - 1] = row;
    });
    const merges = templateElements(documentNode, 'mergeCell').map(node => {
      const reference = node.getAttribute('ref') || '';
      if (!/^[A-Z]+[1-9][0-9]*:[A-Z]+[1-9][0-9]*$/.test(reference)) {
        throw new Error('工作簿模板包含無效合併儲存格。');
      }
      return XLSX_EXPORT.utils.decode_range(reference);
    });
    return { '!cols': columns, '!rows': rows, '!merges': merges };
  }

  function readTrustedTemplateLayouts(templateBuffer, requiredOrder) {
    const archive = trustedTemplateArchive(templateBuffer);
    const workbookDocument = trustedTemplateXml(archive, 'xl/workbook.xml');
    const sheetNames = templateElements(workbookDocument, 'sheet')
      .map(node => node.getAttribute('name') || '');
    if (!requiredOrder.every((name, index) => sheetNames[index] === name)) {
      throw new Error('模板的 11-sheet 順序不符合鎖定格式。');
    }
    return Object.fromEntries(requiredOrder.map((name, index) => [
      name,
      trustedTemplateSheetLayout(archive, index + 1),
    ]));
  }

  async function preserveTemplateWorkbookLayout(templateBuffer, generatedBuffer, visibleSheetCount, styleManifest) {
    if (!XLSX_EXPORT.CFB || typeof XLSX_EXPORT.CFB.read !== 'function' ||
        typeof XLSX_EXPORT.CFB.write !== 'function' || typeof XLSX_EXPORT.CFB.find !== 'function') {
      throw new Error('表格庫缺少模板版式保真能力，已停止導出。');
    }
    const templateZip = XLSX_EXPORT.CFB.read(new Uint8Array(templateBuffer), { type: 'array' });
    const generatedZip = XLSX_EXPORT.CFB.read(new Uint8Array(generatedBuffer), { type: 'array' });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const readXml = (archive, part) => {
      const entry = XLSX_EXPORT.CFB.find(archive, `Root Entry/${part}`);
      if (!entry || !entry.content) throw new Error(`工作簿缺少 ${part}。`);
      return { entry, xml: decoder.decode(entry.content) };
    };
    const writeXml = (entry, xml) => {
      entry.content = encoder.encode(xml);
      entry.size = entry.content.length;
    };

    const templateStyles = readXml(templateZip, 'xl/styles.xml');
    const generatedStyles = readXml(generatedZip, 'xl/styles.xml');
    const templateStyleCount = cellStyleCount(templateStyles.xml);
    const generatedStyleCount = cellStyleCount(generatedStyles.xml);
    const templateStylesHash = await sha256Buffer(templateStyles.entry.content);
    if (templateStyleCount !== CANONICAL_CELL_STYLES.length || generatedStyleCount < 1 ||
        templateStylesHash !== LOCKED_TEMPLATE_STYLES_SHA256) {
      throw new Error('模板樣式表與鎖定格式不一致，已停止導出。');
    }
    if (!styleManifest || typeof styleManifest !== 'object') {
      throw new Error('工作簿缺少鎖定樣式清單，已停止導出。');
    }

    const templateWorkbook = readXml(templateZip, 'xl/workbook.xml');
    const generatedWorkbook = readXml(generatedZip, 'xl/workbook.xml');
    let workbookXml = generatedWorkbook.xml;
    [
      ['workbookPr', ['workbookProtection', 'bookViews', 'sheets']],
      ['workbookProtection', ['bookViews', 'sheets']],
      ['bookViews', ['sheets']],
      ['definedNames', ['calcPr']],
      ['calcPr', []],
    ].forEach(([tag, anchors]) => {
      workbookXml = graftTemplateXmlElement(
        workbookXml, templateWorkbook.xml, tag, anchors, '</workbook>',
      );
    });
    writeXml(generatedWorkbook.entry, workbookXml);

    const tailAnchors = [
      'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties',
      'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing',
      'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems',
      'tableParts', 'extLst',
    ];
    for (let index = 1; index <= visibleSheetCount; index += 1) {
      const part = `xl/worksheets/sheet${index}.xml`;
      const templateSheet = readXml(templateZip, part);
      const generatedSheet = readXml(generatedZip, part);
      let sheetXml = remapGeneratedCellStyles(
        generatedSheet.xml, styleManifest[part], templateStyleCount, part,
      );
      [
        ['sheetPr', ['dimension']],
        ['sheetViews', ['sheetFormatPr', 'cols', 'sheetData']],
        ['sheetFormatPr', ['cols', 'sheetData']],
        ['printOptions', ['pageMargins', ...tailAnchors]],
        ['pageMargins', tailAnchors],
        ['pageSetup', tailAnchors.slice(1)],
        ['headerFooter', tailAnchors.slice(2)],
      ].forEach(([tag, anchors]) => {
        sheetXml = graftTemplateXmlElement(
          sheetXml, templateSheet.xml, tag, anchors, '</worksheet>',
        );
      });
      writeXml(generatedSheet.entry, sheetXml);
    }
    const syncPart = `xl/worksheets/sheet${visibleSheetCount + 1}.xml`;
    const syncSheet = readXml(generatedZip, syncPart);
    writeXml(syncSheet.entry, remapGeneratedCellStyles(
      syncSheet.xml, styleManifest[syncPart], templateStyleCount, syncPart,
    ));
    // Cell style ids now refer to the original template table exactly. Only
    // style/layout metadata is transplanted; generated values, formulas and
    // reverse-sync payloads remain unchanged.
    writeXml(generatedStyles.entry, templateStyles.xml);
    return XLSX_EXPORT.CFB.write(generatedZip, {
      type: 'array', fileType: 'zip', compression: true,
    });
  }

  function downloadWorkbookBytes(bytes, fileName) {
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearImport() {
    state.importFile = null; state.importBuffer = null; state.importHash = null; state.importParsed = null;
    state.importPreview = null; state.importId = null; state.importExpectedRevision = null;
    state.importBlockers = []; state.importBlockerCount = 0;
    $('import-file').value = ''; $('import-file-name').value = '';
    $('preview-import').disabled = true; $('confirm-import').disabled = true;
    $('import-preview').style.display = 'none'; $('import-operations').replaceChildren();
    $('import-replace-all-ack').checked = false; $('import-replace-all-ack').disabled = true;
    $('import-confirm-reason').value = ''; $('import-confirm-reason').disabled = true;
    $('import-confirm-box').classList.remove('blocked');
    $('import-selection').textContent = 'Preview 後才可確認。';
    $('import-log').textContent = '選擇文件後才會啟用隔離解析與 Preview。';
  }

  function flattenEvent(raw) {
    const payloadSource = first(raw, ['event', 'payload', 'payload_json', 'payloadJson'], null);
    const payload = payloadSource === null ? { ...(raw || {}) } : parseJson(payloadSource, {});
    const event = { ...payload };
    event.__server_payload = stableClone(payload);
    event.type = canonicalType(first(payload, ['type', 'event_type', 'eventType'], first(raw, ['eventType', 'event_type', 'type'], '')));
    event.date = dateString(first(payload, ['date', 'trade_date', 'tradeDate'], first(raw, ['tradeDate', 'trade_date', 'date'], '')));
    return event;
  }

  function normalizeConfirmed(raw) {
    const event = flattenEvent(raw);
    event.event_id = first(raw, ['lineageId', 'lineage_id', 'event_id', 'eventId', 'id'], first(event, ['lineageId', 'lineage_id', 'event_id', 'eventId'], ''));
    event.event_version = asNumber(first(raw, ['event_version', 'eventVersion', 'version'], first(event, ['event_version', 'eventVersion'], 1)), 1);
    event.sequence_no = asNumber(first(raw, ['sequence_no', 'sequenceNo', 'sequence'], first(event, ['sequence_no', 'sequenceNo'], 0)), 0);
    event.ledger_revision = asNumber(first(raw, ['ledger_revision', 'ledgerRevision'], first(event, ['ledger_revision', 'ledgerRevision'], 0)), 0);
    event.base_hash = first(raw, ['base_hash', 'baseHash', 'row_hash', 'rowHash'], first(event, ['base_hash', 'baseHash'], ''));
    event.status = String(first(raw, ['status'], first(event, ['status'], 'CONFIRMED'))).toUpperCase();
    return event;
  }

  function syncFreePayload(raw) {
    const payload = stableClone(raw || {});
    [
      'event_id', 'lineage_id', 'event_version', 'ledger_revision',
      'pending_id', 'confirmed_at', 'confirmed_by', 'created_at',
      '__yi_event_id', '__yi_event_version', '__yi_base_hash', '__yi_sync_token',
      '__server_payload', 'base_hash', 'payload_json',
    ].forEach(key => delete payload[key]);
    return payload;
  }

  function eventValue(event, keys, fallback) {
    return first(event, keys, fallback);
  }

  function eventAmount(event) {
    const net = eventValue(event, [
      'net_amount', 'net_amount_decimal', 'amount', 'amount_decimal', 'amountDecimal',
      'net_cash', 'net_cash_decimal', 'cash_change', 'cash_change_decimal',
    ], 0);
    return Math.abs(asNumber(net, 0));
  }

  function eventCash(event) {
    return asNumber(eventValue(event, ['cash_change', 'cash_change_decimal', 'net_cash', 'net_cash_decimal', 'net_amount', 'net_amount_decimal'], 0), 0);
  }

  function corporateActionOutput(event, field) {
    const directKeys = field === 'ticker'
      ? ['post_ticker', 'postTicker']
      : ['post_quantity', 'postQuantity', 'post_qty'];
    const direct = eventValue(event, directKeys, null);
    if (direct !== null && direct !== undefined && direct !== '') return direct;
    const outputs = Array.isArray(event.outputs) ? event.outputs : [];
    const values = outputs.map(output => field === 'ticker'
      ? String(output && output.ticker || '').toUpperCase()
      : asNumber(output && (output.quantity ?? output.qty), 0));
    if (!values.length) return '';
    return values.length === 1 ? values[0] : `[${values.join(',')}]`;
  }

  function eventRow(event, def) {
    const date = dateString(event.date);
    const ticker = String(eventValue(event, ['ticker', 'symbol'], '') || '').toUpperCase();
    const name = eventValue(event, ['name', 'asset_name', 'assetName'], '');
    const quantity = asNumber(eventValue(event, ['quantity', 'qty'], 0), 0);
    const notes = eventValue(event, ['notes', 'note'], '');
    if (def.type === 'BUY' || def.type === 'SELL') {
      const amount = eventAmount(event);
      const price = optionalNumber(eventValue(event, ['price', def.type === 'BUY' ? 'buy_price' : 'sell_price'], null));
      return [null, date, ticker, name, quantity, amount, price, quantity ? amount / quantity : 0, notes];
    }
    if (def.type === 'DIVIDEND') {
      const amount = eventAmount(event);
      return [null, date, ticker, name, quantity, amount, quantity ? amount / quantity : 0, notes];
    }
    if (def.type === 'CORPORATE_ACTION') {
      return [null, date, ticker, name,
        eventValue(event, ['corporate_action_type', 'action_type', 'actionType'], ''),
        asNumber(eventValue(event, ['pre_quantity', 'preQuantity', 'quantity', 'qty'], 0), 0),
        corporateActionOutput(event, 'ticker'), corporateActionOutput(event, 'quantity'),
        eventCash(event), notes];
    }
    if (def.type === 'LIABILITY') {
      return [null, date,
        asNumber(eventValue(event, ['interest_expense', 'interest', 'interestExpense'], 0), 0),
        asNumber(eventValue(event, ['liability_change', 'change', 'liabilityChange'], 0), 0), notes];
    }
    if (def.type === 'CAPITAL') {
      const subscription = asNumber(eventValue(event, ['subscription', 'sub'], 0), 0);
      const redemption = asNumber(eventValue(event, ['redemption', 'red'], 0), 0);
      const unitPrice = asNumber(eventValue(event, ['unit_price', 'unitPrice'], 0), 0);
      const derivedQuantity = unitPrice > 0 ? (subscription - redemption) / unitPrice : quantity;
      return [null, date, eventValue(event, ['shareholder', 'holder'], ''), subscription || null, redemption || null, unitPrice, derivedQuantity, notes];
    }
    if (def.type === 'FUND_ACTION') {
      return [null, date, eventValue(event, ['fund_action_type', 'action_type', 'actionType'], ''), quantity,
        asNumber(eventValue(event, ['post_quantity', 'postQuantity', 'post_qty'], 0), 0), eventCash(event), notes];
    }
    return [];
  }

  function monthKey(date) {
    const value = dateString(date);
    return value ? value.slice(0, 7) : '9999-12';
  }

  function monthRange(key) {
    const [year, month] = key.split('-').map(Number);
    const last = new Date(year, month, 0).getDate();
    return `${year}/${String(month).padStart(2, '0')}/01-${year}/${String(month).padStart(2, '0')}/${String(last).padStart(2, '0')}`;
  }

  function recordTotals(def, events) {
    if (def.total === 'trade' || def.total === 'dividend') return { amount: events.reduce((sum, event) => sum + eventAmount(event), 0) };
    if (def.total === 'cash') return { cash: events.reduce((sum, event) => sum + eventCash(event), 0) };
    if (def.total === 'liability') return {
      interest: events.reduce((sum, event) => sum + asNumber(eventValue(event, ['interest_expense', 'interest'], 0), 0), 0),
      change: events.reduce((sum, event) => sum + asNumber(eventValue(event, ['liability_change', 'change'], 0), 0), 0),
    };
    if (def.total === 'capital') return {
      subscription: events.reduce((sum, event) => sum + asNumber(eventValue(event, ['subscription', 'sub'], 0), 0), 0),
      redemption: events.reduce((sum, event) => sum + asNumber(eventValue(event, ['redemption', 'red'], 0), 0), 0),
    };
    return {};
  }

  function monthHeader(def, currency, key, events) {
    const row = Array(def.visible + META_HEADERS.length).fill('');
    row[0] = monthRange(key);
    const totals = recordTotals(def, events);
    if (def.total === 'trade') { row[3] = 'Total Trade Amount:'; row[5] = round2(totals.amount); }
    if (def.total === 'dividend') { row[3] = 'Total Dividend Amount:'; row[5] = round2(totals.amount); }
    if (def.total === 'cash') {
      const labelIndex = def.type === 'CORPORATE_ACTION' ? 6 : 4;
      const valueIndex = def.type === 'CORPORATE_ACTION' ? 8 : 5;
      row[labelIndex] = 'Total Cash Change:'; row[valueIndex] = round2(totals.cash);
    }
    if (def.total === 'liability') {
      row[2] = 'Total Interest:';
      row[3] = 'Net Liability Change:';
    }
    if (def.total === 'capital') {
      row[2] = 'Total Subscription:'; row[3] = round2(totals.subscription);
      row[4] = 'Total Redemption:'; row[5] = round2(totals.redemption);
    }
    return row;
  }

  function round2(value) {
    return Math.round((asNumber(value, 0) + Number.EPSILON) * 100) / 100;
  }

  function recordWorkbookRows(def, events, currency) {
    const groups = new Map();
    events.forEach(event => {
      const key = monthKey(event.date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    });
    if (!groups.size) groups.set(today().slice(0, 7), []);
    const rows = []; const kinds = []; const merges = [];
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([key, group]) => {
      group.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.sequence_no - b.sequence_no || String(a.event_id).localeCompare(String(b.event_id)));
      const monthRow = rows.length;
      rows.push(monthHeader(def, currency, key, group)); kinds.push('month');
      merges.push({ s: { r: monthRow, c: 0 }, e: { r: monthRow, c: 1 } });
      if (['BUY', 'SELL', 'DIVIDEND'].includes(def.type)) merges.push({ s: { r: monthRow, c: 3 }, e: { r: monthRow, c: 4 } });
      if (def.type === 'CORPORATE_ACTION') merges.push({ s: { r: monthRow, c: 6 }, e: { r: monthRow, c: 7 } });
      const header = [...def.headers(currency), ...META_HEADERS];
      rows.push(header); kinds.push('header');
      group.forEach((event, index) => {
        const visible = eventRow(event, def); visible[0] = index + 1;
        rows.push([
          ...visible,
          event.event_id || '', event.event_version || 1, event.base_hash || '', event.payload_json || '',
        ]);
        kinds.push('data');
      });
      rows.push(Array(def.visible + META_HEADERS.length).fill(null)); kinds.push('spacer');
    });
    rows.pop(); kinds.pop();
    return { rows, kinds, merges };
  }

  function styleClone(style) {
    if (!style || typeof style !== 'object') return style;
    if (typeof structuredClone === 'function') return structuredClone(style);
    return stableClone(style);
  }

  function ensureCell(sheet, row, col) {
    const address = XLSX_EXPORT.utils.encode_cell({ r: row, c: col });
    if (!sheet[address]) sheet[address] = { t: 's', v: '' };
    return sheet[address];
  }

  const DARK_FILL = Object.freeze({ patternType: 'solid', fgColor: { rgb: '2F5B7C' } });
  const LIGHT_FILL = Object.freeze({ patternType: 'solid', fgColor: { rgb: 'D9E2EC' } });
  const WHITE_FILL = Object.freeze({ patternType: 'solid', fgColor: { rgb: 'FFFFFF' } });
  const GRID_BORDER = Object.freeze({
    top: { style: 'thin', color: { rgb: 'B0B0B0' } },
    right: { style: 'thin', color: { rgb: 'B0B0B0' } },
    bottom: { style: 'thin', color: { rgb: 'B0B0B0' } },
    left: { style: 'thin', color: { rgb: 'B0B0B0' } },
  });
  const CANONICAL_CELL_STYLES = Object.freeze([
    Object.freeze({}),
    Object.freeze({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 }, fill: DARK_FILL, alignment: { vertical: 'center' } }),
    Object.freeze({ fill: DARK_FILL }),
    Object.freeze({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: DARK_FILL, alignment: { horizontal: 'right' } }),
    Object.freeze({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: DARK_FILL, numFmt: '#,##0.00' }),
    Object.freeze({ font: { bold: true, sz: 10 }, fill: LIGHT_FILL, border: GRID_BORDER, alignment: { horizontal: 'center', wrapText: true } }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, alignment: { horizontal: 'center' } }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '#,##0' }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '#,##0.00' }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '#,##0.0000' }),
    Object.freeze({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 }, fill: DARK_FILL }),
    Object.freeze({ font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: DARK_FILL }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '#,##0.##' }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '0.00%' }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '+0.0%;-0.0%' }),
    Object.freeze({ font: { sz: 10 }, fill: WHITE_FILL, border: GRID_BORDER, numFmt: '0.000000' }),
  ]);

  const RECORD_DATA_STYLE_IDS = Object.freeze({
    BUY: Object.freeze([6, 7, 7, 7, 8, 9, 10, 10, 7]),
    SELL: Object.freeze([6, 7, 7, 7, 8, 9, 10, 10, 7]),
    DIVIDEND: Object.freeze([6, 7, 7, 7, 8, 9, 10, 7]),
    CORPORATE_ACTION: Object.freeze([6, 7, 7, 7, 7, 8, 7, 7, 9, 7]),
    LIABILITY: Object.freeze([6, 7, 9, 9, 7]),
    CAPITAL: Object.freeze([6, 7, 7, 9, 9, 16, 10, 7]),
    FUND_ACTION: Object.freeze([6, 7, 7, 13, 13, 9, 7]),
  });

  function applyCanonicalStyle(cell, styleId) {
    const style = CANONICAL_CELL_STYLES[styleId] || CANONICAL_CELL_STYLES[0];
    cell.s = styleClone(style);
    cell.__yiCanonicalStyleId = styleId;
    if (style.numFmt) cell.z = style.numFmt;
    return cell;
  }

  function applyRecordStyle(sheet, template, def, rows, kinds) {
    const dataStyles = RECORD_DATA_STYLE_IDS[def.type] || [];
    kinds.forEach((kind, row) => {
      if (kind === 'spacer') return;
      for (let col = 0; col < def.visible; col += 1) {
        const target = ensureCell(sheet, row, col);
        let styleId = 0;
        if (kind === 'month') {
          const value = rows[row][col];
          styleId = col === 0 ? 1 : typeof value === 'number' ? 4 : value ? 3 : 2;
        } else if (kind === 'header') styleId = 5;
        else if (kind === 'data') styleId = dataStyles[col] ?? 7;
        applyCanonicalStyle(target, styleId);
      }
      if (kind === 'header') {
        sheet['!rows'] = sheet['!rows'] || [];
        sheet['!rows'][row] = { hpt: 28 };
      }
    });
    sheet['!cols'] = template && template['!cols']
      ? styleClone(template['!cols'].slice(0, def.visible))
      : def.widths.map(width => ({ wch: width }));
    META_HEADERS.forEach(() => sheet['!cols'].push({ hidden: true, wch: 2 }));
  }

  function buildRecordSheet(template, def, events, currency) {
    const built = recordWorkbookRows(def, events, currency);
    const sheet = XLSX_EXPORT.utils.aoa_to_sheet(built.rows, { cellDates: false });
    sheet['!merges'] = built.merges;
    applyRecordStyle(sheet, template, def, built.rows, built.kinds);
    return sheet;
  }

  function projectionSource(projection, name) {
    const aliases = {
      'Asset Position Record': ['Asset Position Record', 'asset_positions', 'assetPositions', 'positions', 'df_assets'],
      'Liability Statement': ['Liability Statement', 'liability_statement', 'liabilityStatement', 'liability_chain', 'df_liability'],
      'Cash Flow Statement': ['Cash Flow Statement', 'cash_flow', 'cashFlow', 'cash_chain', 'df_cashflow', 'df_cash'],
      'NAV Statement': ['NAV Statement', 'nav_statement', 'navStatement', 'nav_rows', 'navRows', 'nav'],
    };
    const containers = [projection, projection && projection.sheets, projection && projection.python_projection, projection && projection.pythonProjection];
    for (const container of containers) {
      if (!container || typeof container !== 'object') continue;
      for (const key of aliases[name]) {
        if (container[key] !== undefined && container[key] !== null) return container[key];
      }
    }
    return null;
  }

  function projectionArray(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.rows)) return value.rows;
    if (value && Array.isArray(value.items)) return value.items;
    return null;
  }

  function projectionRows(projection, name, currency) {
    const source = projectionSource(projection, name);
    const list = projectionArray(source);
    if (!list) {
      const rows = emptyProjectionRows(name, currency);
      rows.push(['BACKEND PROJECTION UNAVAILABLE · stale template values were cleared.']);
      return rows;
    }
    if (!list.length) return emptyProjectionRows(name, currency);
    if (Array.isArray(list[0])) return list;
    if (typeof list[0] !== 'object') return null;
    if (name === 'Asset Position Record') {
      const headers = ['No.', 'Ticker', 'Asset Name', 'Quantity', `Latest Price (${currency})`, `Market Value (${currency})`, 'Weight (%)', `Total Buy Cost (${currency})`, `Total Sell Proceeds (${currency})`, `Dividend Income (${currency})`, `Net Cost (${currency})`, `Total P&L (${currency})`, 'Nominal Return (%)', 'Exposure Return (%)', 'Notes'];
      const active = list.filter(row => asNumber(first(row, ['quantity', 'qty', 'shares'], 0), 0) > 0.001);
      const rowPrice = row => asNumber(first(row, ['latest_price', 'latestPrice', 'price'], 0), 0);
      const rowMarketValue = row => {
        const explicit = optionalNumber(first(row, ['market_value', 'marketValue'], null));
        return explicit === null
          ? asNumber(first(row, ['quantity', 'qty', 'shares'], 0), 0) * rowPrice(row)
          : explicit;
      };
      const marketValue = active.reduce((sum, row) => sum + rowMarketValue(row), 0);
      const asOf = dateString(first(source, ['as_of', 'asOf', 'date'], first(projection, ['as_of', 'asOf'], today()))) || today();
      const bar = Array(headers.length).fill(''); bar[0] = 'As of Date:'; bar[1] = asOf; bar[10] = `Total Market Value (${currency}):`; bar[12] = round2(marketValue);
      const rows = [bar, headers];
      active.forEach((row, index) => rows.push([
        index + 1, first(row, ['ticker', 'symbol'], ''), first(row, ['name', 'asset_name', 'assetName'], ''),
        first(row, ['quantity', 'qty', 'shares'], 0), rowPrice(row),
        rowMarketValue(row), first(row, ['weight', 'weight_pct', 'weightPct'], marketValue ? rowMarketValue(row) / marketValue : 0),
        first(row, ['total_buy_cost', 'totalBuyCost', 'buy_cost', 'buyCost'], 0), first(row, ['total_sell_proceeds', 'totalSellProceeds', 'sell_proceeds', 'sellProceeds'], 0),
        first(row, ['dividend_income', 'dividendIncome', 'total_dividends'], 0), first(row, ['net_cost', 'netCost'], 0),
        first(row, ['total_pnl', 'totalPnl', 'pnl'], 0), first(row, ['nominal_return', 'nominalReturn'], 0),
        first(row, ['exposure_return', 'exposureReturn'], 0), first(row, ['notes', 'note'], ''),
      ]));
      return rows;
    }
    if (name === 'Liability Statement') {
      const rows = [['No.', 'Date', `Opening Liability (${currency})`, `Interest Paid (${currency})`, `Liability Change (${currency})`, `Closing Liability (${currency})`, 'Notes']];
      list.forEach((row, index) => rows.push([index + 1, first(row, ['date', 'month', '日期'], ''), first(row, ['opening_liability', 'openingLiability', 'liability_before', '原负债'], 0), first(row, ['interest_paid', 'interestPaid', 'interest', '利息支出'], 0), first(row, ['liability_change', 'liabilityChange', 'change', '负债改变'], 0), first(row, ['closing_liability', 'closingLiability', 'liability_after', '现有负债'], 0), first(row, ['notes', 'note'], '')]));
      return rows;
    }
    if (name === 'Cash Flow Statement') {
      const rows = [['Date', 'Source Sheet', 'Trade No.', `Cash Before (${currency})`, `Cash Change (${currency})`, `Cash After (${currency})`]];
      list.forEach(row => rows.push([dateString(first(row, ['date', 'trade_date'], '')), first(row, ['source_sheet', 'sourceSheet', 'source'], ''), first(row, ['trade_no', 'tradeNo', 'sequence_no', 'sequence'], ''), first(row, ['cash_before', 'cashBefore', 'before'], 0), first(row, ['cash_change', 'cashChange', 'change'], 0), first(row, ['cash_after', 'cashAfter', 'after'], 0)]));
      return rows;
    }
    if (name === 'NAV Statement') {
      const rows = [['Date', `Total Assets (${currency})`, `Total Liability (${currency})`, 'Liability/Asset Ratio', `Net Value (${currency})`, 'Total Units', `NAV per Unit (${currency})`, `Fund Action Adjustment (${currency})`, `Cash Balance (${currency})`, `Market Value (${currency})`]];
      list.forEach(row => rows.push([dateString(first(row, ['date', 'nav_date'], '')), first(row, ['total_assets', 'totalAssets'], 0), first(row, ['total_liability', 'totalLiability', 'liability'], 0), first(row, ['liability_asset_ratio', 'liabilityAssetRatio'], 0), first(row, ['net_value', 'netValue'], 0), first(row, ['total_units', 'totalUnits', 'units'], 0), first(row, ['nav_per_unit', 'navPerUnit', 'unit_nav', 'unitNav', 'nav'], 0), first(row, ['fund_action_adjustment', 'fundActionAdjustment'], 0), first(row, ['cash_balance', 'cashBalance', 'cash'], 0), first(row, ['market_value', 'marketValue'], 0)]));
      return rows;
    }
    return null;
  }

  function projectionHeaders(name, currency) {
    if (name === 'Asset Position Record') return ['No.', 'Ticker', 'Asset Name', 'Quantity', `Latest Price (${currency})`, `Market Value (${currency})`, 'Weight (%)', `Total Buy Cost (${currency})`, `Total Sell Proceeds (${currency})`, `Dividend Income (${currency})`, `Net Cost (${currency})`, `Total P&L (${currency})`, 'Nominal Return (%)', 'Exposure Return (%)', 'Notes'];
    if (name === 'Liability Statement') return ['No.', 'Date', `Opening Liability (${currency})`, `Interest Paid (${currency})`, `Liability Change (${currency})`, `Closing Liability (${currency})`, 'Notes'];
    if (name === 'Cash Flow Statement') return ['Date', 'Source Sheet', 'Trade No.', `Cash Before (${currency})`, `Cash Change (${currency})`, `Cash After (${currency})`];
    if (name === 'NAV Statement') return ['Date', `Total Assets (${currency})`, `Total Liability (${currency})`, 'Liability/Asset Ratio', `Net Value (${currency})`, 'Total Units', `NAV per Unit (${currency})`, `Fund Action Adjustment (${currency})`, `Cash Balance (${currency})`, `Market Value (${currency})`];
    return [];
  }

  function emptyProjectionRows(name, currency) {
    const headers = projectionHeaders(name, currency);
    if (!headers.length) return [];
    if (name === 'Asset Position Record') {
      const bar = Array(headers.length).fill('');
      bar[0] = 'As of Date:'; bar[1] = today(); bar[10] = `Total Market Value (${currency}):`; bar[12] = 0;
      return [bar, headers];
    }
    return [headers];
  }

  const PROJECTION_DATA_STYLE_IDS = Object.freeze({
    'Asset Position Record': Object.freeze([6, 7, 7, 13, 10, 9, 14, 9, 9, 9, 9, 9, 15, 15, 7]),
    'Liability Statement': Object.freeze([6, 7, 9, 9, 9, 9, 7]),
    'Cash Flow Statement': Object.freeze([7, 7, 7, 9, 9, 9]),
    'NAV Statement': Object.freeze([7, 9, 9, 14, 9, 8, 16, 9, 9, 9]),
  });

  function buildProjectionSheet(template, rows, name) {
    if (!rows || !rows.length) return template;
    const asset = name === 'Asset Position Record';
    const headerRow = asset ? 1 : 0;
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const sheet = XLSX_EXPORT.utils.aoa_to_sheet(rows, { cellDates: false });
    const dataStyles = PROJECTION_DATA_STYLE_IDS[name] || [];
    rows.forEach((row, rowIndex) => {
      for (let col = 0; col < columns; col += 1) {
        const target = ensureCell(sheet, rowIndex, col);
        let styleId;
        if (asset && rowIndex === 0) {
          styleId = col === 0 ? 11 : col === 1 ? 12 : col === 10 ? 3 : col === 12 ? 4 : 2;
        } else if (rowIndex === headerRow) styleId = 5;
        else styleId = dataStyles[col] ?? 7;
        applyCanonicalStyle(target, styleId);
      }
    });
    const cols = template && template['!cols'] ? styleClone(template['!cols']) : undefined;
    const rowStyles = template && template['!rows'] ? styleClone(template['!rows']) : undefined;
    const merges = template && template['!merges'] ? styleClone(template['!merges']) : undefined;
    sheet['!cols'] = cols;
    sheet['!rows'] = rowStyles || [];
    sheet['!rows'][headerRow] = { ...(sheet['!rows'][headerRow] || {}), hpt: 28 };
    sheet['!merges'] = merges;
    return sheet;
  }

  function setSyncSheet(workbook, data) {
    const name = '_YiSync';
    if (workbook.Sheets[name]) {
      delete workbook.Sheets[name];
      workbook.SheetNames = workbook.SheetNames.filter(sheet => sheet !== name);
    }
    const rows = [
      ['key', 'value'],
      ['schemaVersion', 2],
      ['portfolio', data.portfolio],
      ['currency', data.currency],
      ['ledgerRevision', data.ledgerRevision],
      ['servedRevision', data.servedRevision ?? data.ledgerRevision],
      ['targetRevision', data.targetRevision ?? data.ledgerRevision],
      ['fallback', data.fallback === true],
      ['exportMode', data.exportMode || 'FROZEN_COMPLETE_SNAPSHOT'],
      ['reverseSyncMode', data.reverseSyncMode || 'FULL_LEDGER_REPLACEMENT'],
      ['reverseSyncWritable', data.reverseSyncWritable !== false],
      ['snapshotAsOf', data.snapshotAsOf || ''],
      ['exportId', data.exportId || ''],
      ['syncToken', data.syncToken || ''],
      ['layoutHash', data.layoutHash || ''],
      ['generatedAt', data.snapshotGeneratedAt || new Date().toISOString()],
      ['visibleSheetCount', 11],
      ['eventMetaColumns', META_HEADERS.length],
    ];
    workbook.SheetNames.push(name);
    workbook.Sheets[name] = XLSX_EXPORT.utils.aoa_to_sheet(rows);
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.Sheets = workbook.Workbook.Sheets || workbook.SheetNames.map(sheet => ({ name: sheet, Hidden: 0 }));
    let entry = workbook.Workbook.Sheets.find(sheet => sheet.name === name);
    if (!entry) { entry = { name, Hidden: 2 }; workbook.Workbook.Sheets.push(entry); }
    entry.Hidden = 2;
  }

  async function exportWorkbook() {
    const button = $('export-workbook'); const log = $('export-log');
    button.disabled = true; log.textContent = '正在讀取確認事件與工作簿模板…';
    try {
      await ensureXLSX();
      const result = await api(`/api/admin/ledger/export?portfolio=${encodeURIComponent(state.portfolio)}`);
      const portfolio = String(first(result, ['portfolio'], state.portfolio)).toLowerCase();
      if (portfolio !== state.portfolio) throw new Error('後端返回了錯誤的投資組合。');
      const config = PORTFOLIOS[portfolio];
      const templateResponse = await fetch(config.template, { cache: 'no-store' });
      if (!templateResponse.ok) throw new Error(`工作簿模板讀取失敗（HTTP ${templateResponse.status}）。`);
      const templateBuffer = await templateResponse.arrayBuffer();
      const requiredOrder = [...INPUT_DEFS.slice(0, 4).map(def => def.sheet), 'Asset Position Record', 'Liability Record', 'Liability Statement', 'Capital Record', 'Fund Action Record', 'Cash Flow Statement', 'NAV Statement'];
      const templateLayouts = readTrustedTemplateLayouts(templateBuffer, requiredOrder);
      const workbook = XLSX_EXPORT.utils.book_new();
      const rawEvents = first(result, ['events', 'confirmedEvents', 'confirmed_events'], []);
      let events = (Array.isArray(rawEvents) ? rawEvents : []).map(normalizeConfirmed)
        .filter(event => event.status !== 'PENDING');
      const reversedIds = new Set(events.filter(event => event.type === 'REVERSAL')
        .map(event => first(event, ['reversal_of_event_id', 'reversalOfEventId'], '')).filter(Boolean));
      events = events.filter(event => INPUT_BY_TYPE[event.type] && !reversedIds.has(event.event_id));
      events = await Promise.all(events.map(async event => {
        const copy = { ...event };
        const canonicalPayload = stableClone(copy.__server_payload || syncFreePayload(copy));
        copy.base_hash = await sha256Text(stableStringify(syncFreePayload(canonicalPayload)));
        copy.payload_json = JSON.stringify(canonicalPayload);
        return copy;
      }));
      INPUT_DEFS.forEach(def => {
        const source = templateLayouts[def.sheet];
        workbook.SheetNames.push(def.sheet);
        workbook.Sheets[def.sheet] = buildRecordSheet(source, def, events.filter(event => event.type === def.type), config.currency);
      });
      const projection = first(result, ['projection', 'python_projection', 'pythonProjection'], {}) || {};
      let projectionCount = 0;
      const unavailableProjection = [];
      DERIVED_SHEETS.forEach(name => {
        if (!projectionArray(projectionSource(projection, name))) unavailableProjection.push(name);
        const rows = projectionRows(projection, name, config.currency);
        if (rows && rows.length) {
          const source = templateLayouts[name];
          const insertAfter = requiredOrder.indexOf(name);
          workbook.SheetNames.splice(insertAfter, 0, name);
          workbook.Sheets[name] = buildProjectionSheet(source, rows, name);
          projectionCount += 1;
        }
      });
      const servedRevision = asNumber(first(result, [
        'servedRevision', 'served_revision', 'snapshotLedgerRevision', 'snapshot_ledger_revision',
        'ledgerRevision', 'ledger_revision',
      ], state.ledgerRevision), state.ledgerRevision);
      const targetRevision = asNumber(first(result, [
        'targetRevision', 'target_revision', 'currentLedgerRevision', 'current_ledger_revision',
      ], servedRevision), servedRevision);
      const exportMode = String(first(result, ['exportMode', 'export_mode'], 'FROZEN_COMPLETE_SNAPSHOT'));
      const reverseSyncMode = String(first(result, [
        'reverseSyncMode', 'reverse_sync_mode',
      ], 'FULL_LEDGER_REPLACEMENT'));
      const fallback = first(result, ['fallback'], servedRevision !== targetRevision) === true;
      const reverseSyncWritable = first(result, [
        'reverseSyncWritable', 'reverse_sync_writable',
      ], true) === true;
      const snapshotAsOf = String(first(result, ['snapshotAsOf', 'snapshot_as_of'], '') || '');
      setSyncSheet(workbook, {
        portfolio, currency: first(result, ['currency'], config.currency),
        ledgerRevision: servedRevision,
        servedRevision,
        targetRevision,
        fallback,
        exportMode,
        reverseSyncMode,
        reverseSyncWritable,
        snapshotAsOf,
        snapshotGeneratedAt: first(result, ['snapshotGeneratedAt', 'snapshot_generated_at'], ''),
        exportId: first(result, ['exportId', 'export_id'], ''), syncToken: first(result, ['syncToken', 'sync_token'], ''),
        layoutHash: first(result, ['layoutHash', 'layout_hash'], ''),
      });
      const styleManifest = canonicalStyleManifest(workbook);
      const generatedWorkbook = XLSX_EXPORT.write(workbook, {
        type: 'array', bookType: 'xlsx', compression: true, cellStyles: true,
      });
      const preservedWorkbook = await preserveTemplateWorkbookLayout(
        templateBuffer, generatedWorkbook, requiredOrder.length,
        styleManifest,
      );
      downloadWorkbookBytes(preservedWorkbook, config.file);
      const availableCount = Math.max(0, projectionCount - unavailableProjection.length);
      const unavailableText = unavailableProjection.length
        ? ` · ${unavailableProjection.join(', ')} 後台未提供，已清除模板舊值並標註`
        : '';
      const reverseSyncText = reverseSyncWritable
        ? '可簽名整賬本替換'
        : '凍結 fallback Snapshot；仍可簽名整賬本替換';
      log.textContent = `✓ 已輸出 ${events.length} 筆確認事件 · Snapshot Rev ${servedRevision}（動態目標 Rev ${targetRevision}） · ${snapshotAsOf ? `截至 ${snapshotAsOf} · ` : ''}${reverseSyncText} · 派生表有效重建 ${availableCount}/4${unavailableText}。Pending 未輸出。`;
      $('export-revision').textContent = `已導出 Snapshot Revision ${servedRevision} · 動態 Revision ${targetRevision}`;
    } catch (error) {
      const pipeline = await loadPipelineStatus();
      log.textContent = pipeline && !pipeline.exportReady
        ? `↻ 動態 Revision ${pipeline.targetRevision} 仍在計算／存儲；Excel 不會讀取半成品。${pipeline.completedSnapshotRevision === null ? '' : `最後完整 Snapshot 是 Revision ${pipeline.completedSnapshotRevision}。`}`
        : '✗ ' + error.message;
    } finally {
      button.disabled = Boolean(state.pipelineView && !state.pipelineView.exportReady);
    }
  }

  async function prepareImport(file) {
    if (!file) return;
    clearImport();
    $('import-file-name').value = file.name;
    const log = $('import-log');
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('只接受不含宏的 .xlsx 文件。');
      if (!file.size) throw new Error('文件是空的。');
      if (file.size > MAX_FILE_BYTES) throw new Error(`文件超過 8 MB 上限（目前 ${(file.size / 1024 / 1024).toFixed(2)} MB）。`);
      log.textContent = '正在本地計算 SHA-256，並在一次性隔離程序中解析 7 張事件 sheet…';
      const buffer = await file.arrayBuffer();
      const hash = await sha256Buffer(buffer);
      const parsed = await parseImportWorkbook(buffer);
      state.importFile = file; state.importBuffer = null; state.importHash = hash; state.importParsed = parsed;
      $('preview-import').disabled = false;
      const fallback = parsed.manifest && parsed.manifest.fallback === true;
      log.textContent = `✓ 本地預檢通過：${parsed.rows.length} 個事件行 · SHA-256 ${hash.slice(0, 16)}… · 4 張派生表將忽略。${fallback ? '此為凍結 fallback Snapshot；後台會按目前 revision 做全賬本 Preview + CAS。' : '尚未寫入後台。'}`;
    } catch (error) {
      log.textContent = '✗ ' + error.message;
      $('preview-import').disabled = true;
    }
  }

  function syncManifestRows(rows) {
    const out = {};
    (Array.isArray(rows) ? rows : []).slice(1)
      .forEach(row => { if (row && row[0]) out[String(row[0])] = row[1]; });
    return out;
  }

  function hiddenPayload(value, eventId, location) {
    if (value === null || value === undefined || String(value).trim() === '') {
      if (eventId) throw new Error(`${location} 缺少 __yi_payload_json；請從後台重新下載 Excel。`);
      return null;
    }
    let payload;
    try { payload = typeof value === 'object' ? value : JSON.parse(String(value)); } catch (error) {
      throw new Error(`${location} 的 __yi_payload_json 不是有效 JSON。`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`${location} 的 __yi_payload_json 必須是事件物件。`);
    }
    return stableClone(payload);
  }

  function moneyValue(event, fields) {
    for (const field of fields) {
      const minor = first(event, [`${field}_minor`], null);
      if (minor !== null && minor !== '') return asNumber(minor, 0) / 100;
      const major = first(event, [`${field}_decimal`, field], null);
      if (major !== null && major !== '') return asNumber(major, 0);
    }
    return null;
  }

  function dropMoney(event, fields) {
    fields.forEach(field => {
      delete event[field]; delete event[`${field}_decimal`]; delete event[`${field}_minor`];
    });
  }

  function dropLegacyTaxFields(event) {
    dropMoney(event, [
      'gross_amount', 'withholding_tax', 'transaction_tax', 'tax_amount', 'fees', 'fee_amount',
    ]);
    [
      'gross_amount_inferred', 'tax_status', 'tax_review_required', 'tax_review_reason',
      'tax_mode', 'tax_rate',
    ].forEach(field => delete event[field]);
    return event;
  }

  function setMoney(event, field, value) {
    dropMoney(event, [field]);
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) event[field] = round2(value);
  }

  function operationalAmount(event, type) {
    const value = moneyValue(event, ['net_amount', 'amount', 'net_cash', 'cash_change']);
    if (value === null) return null;
    return ['BUY', 'SELL', 'DIVIDEND'].includes(type) ? Math.abs(value) : value;
  }

  function sameMoney(left, right) {
    return left !== null && right !== null && Math.abs(Number(left) - Number(right)) < 0.005;
  }

  function listValue(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (value === null || value === undefined || String(value).trim() === '') return [];
    return String(value).trim().replace(/^\[/, '').replace(/\]$/, '').split(',')
      .map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  function corporateOutputs(visible, base) {
    const tickers = listValue(visible.post_ticker).map(value => value.toUpperCase());
    const quantities = listValue(visible.post_quantity);
    const existing = Array.isArray(base.outputs) ? base.outputs : [];
    return tickers.map((ticker, index) => {
      const prior = existing[index] && String(existing[index].ticker || '').toUpperCase() === ticker
        ? existing[index] : {};
      const quantity = quantities[index] === undefined || quantities[index] === '' ? null : optionalNumber(quantities[index]);
      return cleanEvent({ ticker, name: prior.name || '', quantity, allocation: prior.allocation });
    });
  }

  function mergeExcelEvent(def, visible, payload, isExisting) {
    const base = payload ? syncFreePayload(payload) : {};
    const event = { ...base };
    event.schema_version = asNumber(first(base, ['schema_version'], 1), 1);
    event.type = def.type;
    event.event_type = def.type;
    event.date = visible.date;
    event.trade_date = visible.date;
    event.notes = String(first(visible, ['notes'], '') || '').trim();

    if (['BUY', 'SELL', 'DIVIDEND'].includes(def.type)) {
      event.ticker = String(visible.ticker || '').toUpperCase();
      event.name = String(visible.name || '').trim();
      event.quantity = asNumber(visible.quantity, 0);
      if (def.type === 'DIVIDEND') {
        delete event.price;
      } else {
        const visiblePrice = optionalNumber(visible.price);
        // Price is only a reference. A blank Excel cell must not erase an
        // existing reference price; CPS is always recomputed from Amount / quantity.
        if (visiblePrice !== null) event.price = visiblePrice;
        else if (!isExisting) delete event.price;
      }
      const net = Math.abs(asNumber(visible.amount, 0));
      const priorNet = operationalAmount(base, def.type);
      const changed = !isExisting || !sameMoney(net, priorNet);
      if (changed) {
        dropMoney(event, [
          'gross_amount', 'net_amount', 'operational_amount', 'cash_change', 'net_cash', 'amount',
          'per_share', 'gross_per_share', 'tax_amount', 'fee_amount',
        ]);
        dropLegacyTaxFields(event);
        setMoney(event, 'amount', net);
      } else {
        event.amount = net;
      }
      return cleanEvent(event);
    }

    if (def.type === 'CORPORATE_ACTION') {
      event.ticker = String(visible.ticker || '').toUpperCase();
      event.name = String(visible.name || '').trim();
      event.action_type = String(visible.corporate_action_type || '').toUpperCase();
      event.pre_quantity = asNumber(visible.quantity, 0);
      event.outputs = corporateOutputs(visible, base);
    }
    if (def.type === 'FUND_ACTION') {
      event.action_type = String(visible.fund_action_type || '').toUpperCase();
      event.pre_units = optionalNumber(visible.quantity);
      event.post_units = optionalNumber(visible.post_quantity);
    }
    if (def.type === 'CORPORATE_ACTION' || def.type === 'FUND_ACTION') {
      const net = asNumber(visible.cash_change, 0);
      const priorNet = operationalAmount(base, def.type);
      const changed = !isExisting || !sameMoney(net, priorNet);
      if (changed) {
        dropMoney(event, [
          'gross_amount', 'cash_amount', 'operational_amount', 'net_amount', 'cash_change',
          'net_cash', 'amount', 'tax_amount', 'fee_amount',
        ]);
        dropLegacyTaxFields(event);
        setMoney(event, 'cash_change', net);
      }
      return cleanEvent(event);
    }

    if (def.type === 'LIABILITY') {
      setMoney(event, 'interest', asNumber(visible.interest_expense, 0));
      setMoney(event, 'change', asNumber(visible.liability_change, 0));
      return cleanEvent(event);
    }
    if (def.type === 'CAPITAL') {
      event.shareholder = String(visible.shareholder || '').trim();
      setMoney(event, 'subscription', asNumber(visible.subscription, 0));
      setMoney(event, 'redemption', asNumber(visible.redemption, 0));
      dropMoney(event, ['unit_price']);
      event.unit_price = asNumber(visible.unit_price, 0);
      return cleanEvent(event);
    }
    return cleanEvent(event);
  }

  async function readWorkbookInIsolatedWorker(buffer) {
    if (window.YC_LEDGER_TEST_MODE === true &&
        typeof window.YC_LEDGER_IMPORT_READER === 'function') {
      return window.YC_LEDGER_IMPORT_READER(buffer);
    }
    if (typeof Worker !== 'function') {
      throw new Error('瀏覽器不支援隔離 Excel 解析，已停止匯入。');
    }
    return new Promise((resolve, reject) => {
      const parser = new Worker(XLSX_IMPORT_WORKER);
      const timeout = setTimeout(() => {
        parser.terminate();
        reject(new Error('隔離 Excel 解析超時，已終止且未上傳任何資料。'));
      }, 15_000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        parser.terminate();
        if (error) reject(error); else resolve(value);
      };
      parser.onerror = () => finish(new Error('隔離 Excel 解析失敗，已停止匯入。'));
      parser.onmessage = event => {
        const result = event && event.data;
        if (!result || result.ok !== true || !Array.isArray(result.sheetNames) ||
            !result.sheets || typeof result.sheets !== 'object') {
          finish(new Error(String(result && result.error || '隔離 Excel 解析返回無效結果。')));
          return;
        }
        finish(null, result);
      };
      const isolatedCopy = buffer.slice(0);
      parser.postMessage({ type: 'PARSE_YICAPITAL_XLSX', buffer: isolatedCopy }, [isolatedCopy]);
    });
  }

  async function parseImportWorkbook(buffer) {
    const workbook = await readWorkbookInIsolatedWorker(buffer);
    const sheetNames = workbook.sheetNames;
    const sheetRows = workbook.sheets;
    const missing = INPUT_DEFS.filter(def => !sheetRows[def.sheet]).map(def => def.sheet);
    if (missing.length) throw new Error('缺少事件 sheet：' + missing.join(', '));
    const manifest = syncManifestRows(sheetRows._YiSync);
    if (manifest.portfolio && String(manifest.portfolio).toLowerCase() !== state.portfolio) {
      throw new Error(`工作簿屬於 ${String(manifest.portfolio).toUpperCase()}，目前頁面選中 ${state.portfolio.toUpperCase()}。`);
    }
    if (state.ledgerRevision > 0 && (!manifest.exportId || !manifest.syncToken)) {
      throw new Error('正式賬本只接受從本頁最新匯出的簽名 Excel；請先重新下載。');
    }
    const rows = [];
    for (const def of INPUT_DEFS) {
      const data = sheetRows[def.sheet];
      for (let index = 0; index < data.length; index += 1) {
        const row = data[index];
        const number = Number(row[0]);
        const date = dateString(row[1]);
        if (!Number.isFinite(number) || number <= 0 || !date) continue;
        const eventId = row[def.visible] == null ? '' : String(row[def.visible]).trim();
        const eventVersion = row[def.visible + 1] == null ? null : asNumber(row[def.visible + 1], null);
        const baseHash = row[def.visible + 2] == null ? '' : String(row[def.visible + 2]).trim();
        const payload = hiddenPayload(row[def.visible + 3], eventId, `${def.sheet} Row ${index + 1}`);
        if (eventId && baseHash) {
          const payloadHash = await sha256Text(stableStringify(syncFreePayload(payload)));
          if (payloadHash !== baseHash) {
            throw new Error(`${def.sheet} Row ${index + 1} 的隱藏 payload 與 base hash 不符；請不要編輯隱藏欄，並從後台重新下載 Excel。`);
          }
        }
        const visible = excelEvent(def, row, date);
        const event = mergeExcelEvent(def, visible, payload, !!eventId);
        rows.push({
          sheetName: def.sheet, rowNumber: index + 1, eventId: eventId || null,
          eventVersion, baseHash: baseHash || null, event,
        });
      }
    }
    if (rows.length > MAX_IMPORT_ROWS) throw new Error(`完整 Excel 最多包含 ${MAX_IMPORT_ROWS} 筆事件；請清理無效或重複行後整本重新 Preview。`);
    return {
      workbook: null, rows, manifest,
      baseLedgerRevision: asNumber(manifest.ledgerRevision, state.ledgerRevision),
      exportId: manifest.exportId || null, syncToken: manifest.syncToken || null,
      ignoredDerivedSheets: DERIVED_SHEETS.filter(name => sheetNames.includes(name)),
    };
  }
  function excelEvent(def, row, date) {
    const notes = valueOrNull(row[def.visible - 1]);
    if (def.type === 'BUY' || def.type === 'SELL') return cleanEvent({ schema_version: 1, type: def.type, date, ticker: upper(row[2]), name: valueOrNull(row[3]), quantity: optionalNumber(row[4]), amount: optionalNumber(row[5]), price: optionalNumber(row[6]), notes });
    if (def.type === 'DIVIDEND') return cleanEvent({ schema_version: 1, type: def.type, date, ticker: upper(row[2]), name: valueOrNull(row[3]), quantity: optionalNumber(row[4]), amount: optionalNumber(row[5]), notes });
    if (def.type === 'CORPORATE_ACTION') return cleanEvent({ schema_version: 1, type: def.type, date, ticker: upper(row[2]), name: valueOrNull(row[3]), corporate_action_type: upper(row[4]), quantity: optionalNumber(row[5]), post_ticker: valueOrNull(row[6]), post_quantity: valueOrNull(row[7]), cash_change: optionalNumber(row[8]), notes });
    if (def.type === 'LIABILITY') return cleanEvent({ schema_version: 1, type: def.type, date, interest_expense: optionalNumber(row[2]), liability_change: optionalNumber(row[3]), notes });
    if (def.type === 'CAPITAL') return cleanEvent({ schema_version: 1, type: def.type, date, shareholder: valueOrNull(row[2]), subscription: optionalNumber(row[3]), redemption: optionalNumber(row[4]), unit_price: optionalNumber(row[5]), quantity: optionalNumber(row[6]), notes });
    if (def.type === 'FUND_ACTION') return cleanEvent({ schema_version: 1, type: def.type, date, fund_action_type: upper(row[2]), quantity: optionalNumber(row[3]), post_quantity: optionalNumber(row[4]), cash_change: optionalNumber(row[5]), notes });
    return { schema_version: 1, type: def.type, date };
  }

  function valueOrNull(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    return String(value).trim();
  }
  function upper(value) {
    return valueOrNull(value) ? String(value).trim().toUpperCase() : null;
  }
  function cleanEvent(event) {
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  }

  async function previewImport() {
    if (!state.importParsed || !state.importFile || !state.importHash) return;
    const button = $('preview-import'); const log = $('import-log');
    state.importId = null; state.importBlockers = []; state.importBlockerCount = 0;
    $('import-replace-all-ack').checked = false; $('import-replace-all-ack').disabled = true;
    $('import-confirm-reason').disabled = true;
    button.disabled = true; $('confirm-import').disabled = true;
    log.textContent = '正在把本地事件行送往後台做三方差異比較…';
    try {
      const parsed = state.importParsed;
      const result = await api('/api/admin/ledger/import/preview', {
        method: 'POST',
        body: JSON.stringify({
          portfolio: state.portfolio, fileName: state.importFile.name, uploadSha256: state.importHash,
          baseLedgerRevision: parsed.baseLedgerRevision, rows: parsed.rows,
          exportId: parsed.exportId, syncToken: parsed.syncToken,
          replaceAll: true,
          sourceSnapshotRevision: revisionNumber(parsed.manifest.servedRevision ?? parsed.manifest.ledgerRevision),
          sourceTargetRevision: revisionNumber(parsed.manifest.targetRevision),
          sourceExportMode: parsed.manifest.exportMode || null,
          sourceReverseSyncMode: parsed.manifest.reverseSyncMode || 'FULL_LEDGER_REPLACEMENT',
          ignoredDerivedSheets: parsed.ignoredDerivedSheets,
        }),
      });
      state.importPreview = result;
      state.importId = first(result, ['importId', 'import_id', 'id'], '');
      state.importExpectedRevision = asNumber(first(result, [
        'currentLedgerRevision', 'current_ledger_revision',
        'expectedLedgerRevision', 'expected_ledger_revision', 'ledgerRevision', 'ledger_revision',
      ], state.ledgerRevision), state.ledgerRevision);
      renderImportPreview(result);
      log.textContent = `✓ 差異預覽已建立 · Import ${state.importId || '—'} · 四張派生表不反寫。`;
    } catch (error) {
      state.importId = null; state.importBlockers = []; state.importBlockerCount = 0;
      log.textContent = '✗ ' + error.message;
      $('import-preview').style.display = 'none';
    } finally {
      button.disabled = false;
    }
  }

  function previewOperations(result) {
    const direct = first(result, ['operations', 'rows', 'items'], null);
    if (Array.isArray(direct)) return direct;
    const preview = first(result, ['preview'], null);
    if (preview && Array.isArray(preview.operations)) return preview.operations;
    if (preview && Array.isArray(preview.rows)) return preview.rows;
    return [];
  }

  function operationKind(operation) {
    const kind = String(first(operation, ['operation', 'classification', 'kind', 'type'], 'ERROR')).toUpperCase();
    return ({
      DELETE: 'MISSING',
      REMOVE: 'MISSING',
      MISSING_FROM_EXCEL: 'MISSING',
      MISSING_IN_EXCEL: 'MISSING',
    })[kind] || kind;
  }

  function importBlockerItems(result, operations) {
    const preview = first(result, ['preview'], null) || {};
    const direct = first(result, ['blockers', 'blockingErrors', 'blocking_errors'],
      first(preview, ['blockers', 'blockingErrors', 'blocking_errors'], []));
    const declared = Array.isArray(direct) ? direct : direct ? [direct] : [];
    if (declared.length) return declared;
    return operations.filter(operation => ['ERROR', 'CONFLICT', 'BLOCKER'].includes(operationKind(operation)));
  }

  function summarizeImportPreview(result) {
    const operations = previewOperations(result);
    const operationCounts = { CREATE: 0, UPDATE: 0, MISSING: 0 };
    operations.forEach(operation => {
      const kind = operationKind(operation);
      if (operationCounts[kind] !== undefined) operationCounts[kind] += 1;
    });
    const summary = first(result, ['summary', 'counts'], {}) || {};
    const count = (kind, aliases) => {
      const keys = [kind, kind.toLowerCase(), ...aliases];
      const declared = first(summary, keys, first(result, keys, null));
      return declared === null ? operationCounts[kind] : Math.max(0, asNumber(declared, operationCounts[kind]));
    };
    const blockers = importBlockerItems(result, operations);
    const explicitBlockerCount = first(summary, [
      'BLOCKERS', 'blockers', 'blocking', 'blockingCount', 'blocking_count',
    ], first(result, ['blockerCount', 'blocker_count', 'blockingCount', 'blocking_count'], null));
    const errorCount = asNumber(first(summary, ['ERROR', 'error', 'errorCount', 'error_count'],
      first(result, ['errorCount', 'error_count'], 0)), 0);
    const conflictCount = asNumber(first(summary, ['CONFLICT', 'conflict', 'conflictCount', 'conflict_count'],
      first(result, ['conflictCount', 'conflict_count'], 0)), 0);
    const declaredBlockers = Math.max(0, explicitBlockerCount === null
      ? errorCount + conflictCount || blockers.length
      : asNumber(explicitBlockerCount, blockers.length));
    if (!blockers.length && declaredBlockers > 0) {
      blockers.push({ operation: 'BLOCKER', error: `${declaredBlockers} 項後台 blocker` });
    }
    return {
      operations,
      blockers,
      counts: {
        CREATE: count('CREATE', ['createCount', 'create_count']),
        UPDATE: count('UPDATE', ['updateCount', 'update_count']),
        MISSING: count('MISSING', [
          'MISSING_IN_EXCEL', 'missingInExcel', 'missing_in_excel',
          'missingCount', 'missing_count',
        ]),
        BLOCKERS: Math.max(blockers.length, declaredBlockers),
      },
    };
  }

  function renderImportPreview(result) {
    const preview = summarizeImportPreview(result);
    const { operations, counts, blockers } = preview;
    state.importBlockers = blockers;
    state.importBlockerCount = counts.BLOCKERS;
    const summary = $('import-summary'); summary.replaceChildren();
    [['CREATE', counts.CREATE], ['UPDATE', counts.UPDATE], ['MISSING', counts.MISSING], ['BLOCKERS', counts.BLOCKERS]].forEach(([label, value]) => {
      const item = el('div'); item.append(el('b', '', value), el('span', '', label)); summary.append(item);
    });
    const host = $('import-operations'); host.replaceChildren();
    if (!operations.length) host.append(el('div', 'empty-state', '後台沒有返回逐行操作。'));
    operations.forEach(operation => host.append(importOperation(operation)));
    if (blockers.length && !operations.some(operation => ['ERROR', 'CONFLICT', 'BLOCKER'].includes(operationKind(operation)))) {
      blockers.forEach(blocker => host.append(importOperation(typeof blocker === 'object'
        ? blocker : { operation: 'BLOCKER', error: String(blocker) })));
    }
    const blocked = counts.BLOCKERS > 0;
    $('import-confirm-box').classList.toggle('blocked', blocked);
    $('import-replace-all-ack').checked = false;
    $('import-replace-all-ack').disabled = blocked;
    $('import-confirm-reason').value = DEFAULT_REPLACE_REASON;
    $('import-confirm-reason').disabled = blocked;
    $('import-preview').style.display = 'block';
    updateImportConfirmation();
  }

  function importOperation(operation) {
    const kind = operationKind(operation);
    const card = el('div', `import-op ${kind.toLowerCase()}`);
    const body = el('div');
    const title = el('div', 'ledger-title');
    title.append(el('span', `ledger-pill ${kind.toLowerCase()}`, kind), el('span', 'ledger-pill', first(operation, ['sheetName', 'sheet_name'], '—')), el('span', 'ledger-pill', `Row ${first(operation, ['rowNumber', 'row_number'], '—')}`));
    const errorText = first(operation, ['error', 'errorText', 'error_text', 'message'], '');
    const diff = first(operation, ['diff', 'diff_json', 'changes'], null);
    body.append(title);
    if (errorText) body.append(el('div', 'ledger-meta', errorText));
    if (kind === 'MISSING' && !errorText) {
      body.append(el('div', 'ledger-meta', '此事件不會進入新的 active revision；舊版本仍保留在不可變歷史中，不會 truncate。'));
    }
    if (diff) body.append(el('pre', 'import-diff', typeof diff === 'string' ? diff : JSON.stringify(diff, null, 2)));
    card.append(body);
    return card;
  }

  function importConfirmationState({ importId, blockerCount, acknowledged, reason }) {
    const blockers = Math.max(0, asNumber(blockerCount, 0));
    const normalizedReason = String(reason || '').trim();
    const canConfirm = Boolean(importId) && blockers === 0 && acknowledged === true && Boolean(normalizedReason);
    const message = blockers > 0
      ? `${blockers} 項 blocker；禁止整賬本確認。`
      : acknowledged !== true
        ? '請明確勾選整賬本替換與歷史保留確認。'
        : !normalizedReason
          ? '請填寫整賬本替換理由。'
          : '已確認整賬本替換；舊版本保留歷史，可提交。';
    return { canConfirm, message, reason: normalizedReason };
  }

  function updateImportConfirmation() {
    const confirmation = importConfirmationState({
      importId: state.importId,
      blockerCount: state.importBlockerCount,
      acknowledged: $('import-replace-all-ack').checked === true,
      reason: $('import-confirm-reason').value,
    });
    $('confirm-import').disabled = !confirmation.canConfirm;
    $('import-selection').textContent = confirmation.message;
  }

  async function confirmImport() {
    updateImportConfirmation();
    const button = $('confirm-import'); const log = $('import-log');
    if (button.disabled || !state.importId) return;
    const reason = String($('import-confirm-reason').value || '').trim();
    button.disabled = true; log.textContent = '正在以 CAS 原子建立新的 active ledger revision；舊版本會保留歷史，不會 truncate…';
    try {
      const result = await api('/api/admin/ledger/import/confirm', {
        method: 'POST',
        body: JSON.stringify({
          importId: state.importId,
          expectedLedgerRevision: state.importExpectedRevision,
          replaceAll: true,
          confirmation: { replaceAll: true, reason },
        }),
      });
      const revision = asNumber(first(result, ['ledgerRevision', 'ledger_revision'], state.importExpectedRevision), state.importExpectedRevision);
      const replaced = asNumber(first(result, ['eventCount', 'event_count', 'replaced', 'staged'], state.importParsed && state.importParsed.rows.length || 0), 0);
      log.textContent = `✓ Excel 完整事件賬本已原子簽入 · ${replaced} events · Ledger Revision ${revision}。舊資料版本完整保留在歷史中，沒有刪除或 truncate。`;
      state.importId = null; $('confirm-import').disabled = true;
      await loadLedger();
    } catch (error) {
      log.textContent = '✗ ' + error.message + '；若 Revision 已變，請重新建立預覽。';
      updateImportConfirmation();
    }
  }

  function legacyExpectedPhrase(portfolio) {
    return `CONFIRM LEGACY ${String(portfolio || state.portfolio).toUpperCase()}`;
  }

  function legacyMessageText(value) {
    if (typeof value === 'string') return value.slice(0, 600);
    if (!value || typeof value !== 'object') return String(value || '未提供詳情').slice(0, 600);
    const code = first(value, ['code', 'type', 'kind'], '');
    const message = first(value, ['message', 'warning', 'error', 'reason', 'detail'], '');
    const fallback = (() => { try { return JSON.stringify(value); } catch (error) { return '無法顯示詳情'; } })();
    return [code, message].filter(Boolean).join(' · ').slice(0, 600) || fallback.slice(0, 600);
  }

  function renderLegacyStats(host, items) {
    host.replaceChildren();
    items.forEach(([label, value]) => {
      const item = el('div');
      item.append(el('b', '', value), el('span', '', label));
      host.append(item);
    });
  }

  function renderLegacyMessages(host, errors, warnings) {
    host.replaceChildren();
    (errors || []).forEach(message => host.append(el('div', 'err', legacyMessageText(message))));
    (warnings || []).slice(0, 20).forEach(message => host.append(el('div', '', legacyMessageText(message))));
    if ((warnings || []).length > 20) {
      host.append(el('div', '', `另有 ${(warnings || []).length - 20} 項 warning，完整內容仍保留在本地 package／後台 Preview。`));
    }
    host.hidden = host.childElementCount === 0;
  }

  function normalizeLegacyPackage(raw, selectedPortfolio) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('migration JSON 頂層必須是 object。');
    const issues = [];
    const schemaVersion = String(first(raw, ['schema_version', 'schemaVersion'], '')).trim();
    if (schemaVersion !== 'legacy-ledger-migration-v1') issues.push('schema_version 必須嚴格等於 legacy-ledger-migration-v1。');
    const portfolio = String(first(raw, ['portfolio_id', 'portfolioId', 'portfolio'], '')).trim().toLowerCase();
    if (!PORTFOLIOS[portfolio]) issues.push('portfolio 必須是 us、hk 或 a。');
    else if (portfolio !== selectedPortfolio) issues.push(`package 屬於 ${portfolio.toUpperCase()}，目前頁面選中 ${selectedPortfolio.toUpperCase()}。`);
    const currency = String(first(raw, ['currency'], '')).trim().toUpperCase();
    if (currency && currency !== PORTFOLIOS[selectedPortfolio].currency) {
      issues.push(`package currency ${currency} 與目前基金 ${PORTFOLIOS[selectedPortfolio].currency} 不一致。`);
    }

    const sourceWorkbookSha256 = String(first(raw, ['source_workbook_sha256', 'sourceWorkbookSha256'], '')).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceWorkbookSha256)) issues.push('source_workbook_sha256 必須是 64 位小寫 hex。');

    const events = first(raw, ['events'], null);
    if (!Array.isArray(events)) throw new Error('events 必須是 array。');
    if (!events.length) issues.push('events 不可為空。');
    if (events.length > MAX_LEGACY_EVENTS) issues.push(`events 超過後台單次上限 ${MAX_LEGACY_EVENTS}。`);

    const historicalNavRows = first(raw, ['historical_nav_rows', 'historicalNavRows'], []);
    const historicalPriceRows = first(raw, ['historical_price_rows', 'historicalPriceRows'], []);
    if (!Array.isArray(historicalNavRows)) throw new Error('historical_nav_rows 必須是 array。');
    if (!Array.isArray(historicalPriceRows)) throw new Error('historical_price_rows 必須是 array。');
    if (historicalNavRows.length) issues.push('historical_nav_rows 必須為空；NAV 只能從 confirmed events + raw prices 派生。');
    if (historicalPriceRows.length) issues.push('historical_price_rows 必須為空；歷史價格只能由 raw-close 價格帶提供。');

    const warnings = first(raw, ['warnings'], []);
    const blockingErrors = first(raw, ['blocking_errors', 'blockingErrors'], []);
    if (!Array.isArray(warnings)) throw new Error('warnings 必須是 array。');
    if (!Array.isArray(blockingErrors)) throw new Error('blocking_errors 必須是 array。');

    const declaredEventCount = asNumber(first(raw, ['event_count', 'eventCount'], events.length), NaN);
    const declaredWarningCount = asNumber(first(raw, ['warning_count', 'warningCount'], warnings.length), NaN);
    const declaredBlockingCount = asNumber(first(raw, ['blocking_error_count', 'blockingErrorCount'], blockingErrors.length), NaN);
    const declaredNavRowCount = asNumber(first(raw, ['historical_nav_row_count', 'historicalNavRowCount'], historicalNavRows.length), NaN);
    const declaredPriceRowCount = asNumber(first(raw, ['historical_price_row_count', 'historicalPriceRowCount'], historicalPriceRows.length), NaN);
    if (!Number.isInteger(declaredEventCount) || declaredEventCount !== events.length) issues.push(`event_count 與 events 長度不一致（${declaredEventCount} / ${events.length}）。`);
    if (!Number.isInteger(declaredWarningCount) || declaredWarningCount !== warnings.length) issues.push(`warning_count 與 warnings 長度不一致（${declaredWarningCount} / ${warnings.length}）。`);
    if (!Number.isInteger(declaredBlockingCount) || declaredBlockingCount !== blockingErrors.length) issues.push(`blocking_error_count 與 blocking_errors 長度不一致（${declaredBlockingCount} / ${blockingErrors.length}）。`);
    if (!Number.isInteger(declaredNavRowCount) || declaredNavRowCount !== historicalNavRows.length) issues.push(`historical_nav_row_count 與 historical_nav_rows 長度不一致（${declaredNavRowCount} / ${historicalNavRows.length}）。`);
    if (!Number.isInteger(declaredPriceRowCount) || declaredPriceRowCount !== historicalPriceRows.length) issues.push(`historical_price_row_count 與 historical_price_rows 長度不一致（${declaredPriceRowCount} / ${historicalPriceRows.length}）。`);

    const eventIds = new Set();
    events.forEach((event, index) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        issues.push(`第 ${index + 1} 筆 event 不是 object。`);
        return;
      }
      const eventId = String(first(event, ['event_id', 'eventId'], '')).trim();
      if (!/^legacy_[a-z]+_[a-f0-9]{16,64}$/.test(eventId)) issues.push(`第 ${index + 1} 筆缺少有效 deterministic legacy event_id。`);
      else if (eventIds.has(eventId)) issues.push(`package 內重複 event_id：${eventId}`);
      else eventIds.add(eventId);
    });

    const readyForConfirm = first(raw, ['ready_for_confirm', 'readyForConfirm'], false) === true;
    if (!readyForConfirm) issues.push('ready_for_confirm 不是 true。');
    if (blockingErrors.length || declaredBlockingCount > 0) issues.push('package 仍有 blocking errors，禁止 Preview。');

    return {
      portfolio,
      sourceWorkbookSha256,
      eventCount: events.length,
      warningCount: warnings.length,
      readyForConfirm,
      warnings,
      blockingErrors,
      issues,
      eligible: issues.length === 0,
      payload: {
        portfolio_id: portfolio,
        source_workbook_sha256: sourceWorkbookSha256,
        events: stableClone(events),
        historical_nav_rows: [],
        historical_price_rows: [],
      },
    };
  }

  function resetLegacyPreview() {
    state.legacyPreview = null; state.legacyImportId = null; state.legacyMigrationHash = null;
    state.legacyRequirements = null; state.legacyConfirmed = false;
    $('legacy-preview').hidden = true;
    $('legacy-preview-summary').replaceChildren();
    $('legacy-import-id').textContent = '—'; $('legacy-migration-hash').textContent = '—';
    $('legacy-preview-messages').replaceChildren(); $('legacy-preview-messages').hidden = true;
    $('legacy-confirm-phrase').value = ''; $('legacy-confirm-phrase').disabled = false;
    $('legacy-confirm-phrase').removeAttribute('aria-invalid');
    $('legacy-required-phrase').textContent = legacyExpectedPhrase(state.portfolio);
    LEGACY_ACKS.forEach(item => {
      $(item.input).checked = false; $(item.input).disabled = true;
      $(item.row).classList.remove('required'); $(item.state).textContent = '待 Preview';
    });
    $('confirm-legacy').disabled = true; $('drain-legacy-outbox').disabled = true;
    $('legacy-confirm-state').textContent = 'Preview 後才可確認。';
  }

  function clearLegacyMigration() {
    state.legacyPackage = null;
    $('legacy-json').value = '';
    $('legacy-package').hidden = true;
    $('legacy-package-summary').replaceChildren();
    $('legacy-source-sha').textContent = '—';
    $('legacy-package-messages').replaceChildren(); $('legacy-package-messages').hidden = true;
    $('preview-legacy').disabled = true;
    resetLegacyPreview();
    $('legacy-log').textContent = `尚未解析。選擇上方 ${state.portfolio.toUpperCase()} 基金後再貼入對應 package。`;
  }

  function invalidateLegacyPackage() {
    if (!state.legacyPackage && !state.legacyPreview) return;
    state.legacyPackage = null;
    $('legacy-package').hidden = true; $('preview-legacy').disabled = true;
    resetLegacyPreview();
    $('legacy-log').textContent = 'JSON 內容已改動，請重新解析；先前 Preview 已從此頁面失效。';
  }

  function parseLegacyMigrationPackage() {
    const text = $('legacy-json').value;
    const log = $('legacy-log');
    state.legacyPackage = null;
    $('legacy-package').hidden = true; $('preview-legacy').disabled = true;
    resetLegacyPreview();
    try {
      if (!text.trim()) throw new Error('請先貼上 migration JSON。');
      const byteLength = new TextEncoder().encode(text).byteLength;
      if (byteLength > MAX_LEGACY_JSON_BYTES) throw new Error('migration JSON 超過 2 MiB，已停止處理。');
      let raw;
      try { raw = JSON.parse(text); } catch (error) { throw new Error('JSON 格式無效：' + error.message); }
      const parsed = normalizeLegacyPackage(raw, state.portfolio);
      state.legacyPackage = parsed;
      renderLegacyStats($('legacy-package-summary'), [
        ['PORTFOLIO', parsed.portfolio ? parsed.portfolio.toUpperCase() : 'INVALID'],
        ['SOURCE SHA', parsed.sourceWorkbookSha256 ? `${parsed.sourceWorkbookSha256.slice(0, 10)}…` : 'INVALID'],
        ['EVENTS', parsed.eventCount],
        ['WARNINGS', parsed.warningCount],
        ['READY', parsed.eligible ? 'YES' : 'NO'],
      ]);
      $('legacy-source-sha').textContent = parsed.sourceWorkbookSha256 || '—';
      renderLegacyMessages($('legacy-package-messages'), [...parsed.blockingErrors, ...parsed.issues], parsed.warnings);
      $('legacy-package').hidden = false;
      $('preview-legacy').disabled = !parsed.eligible;
      log.textContent = parsed.eligible
        ? `✓ 本地 package 可 Preview · ${parsed.eventCount} events · ${parsed.warningCount} warnings · 內容仍只在此瀏覽器記憶體。`
        : `✗ 本地 package 未通過核驗，共 ${parsed.blockingErrors.length + parsed.issues.length} 項阻斷。`;
    } catch (error) {
      log.textContent = '✗ ' + error.message;
    }
  }

  function validateLegacyPreview(result, parsed) {
    if (!result || result.migration !== true) throw new Error('後台未返回有效 migration Preview。');
    const importId = String(first(result, ['importId', 'import_id'], '')).trim();
    const migrationHash = String(first(result, ['migrationHash', 'migration_hash'], '')).trim().toLowerCase();
    const portfolio = String(first(result, ['portfolio', 'portfolio_id'], '')).trim().toLowerCase();
    const sourceSha = String(first(result, ['sourceWorkbookSha256', 'source_workbook_sha256'], '')).trim().toLowerCase();
    const eventCount = asNumber(first(result, ['eventCount', 'event_count'], NaN), NaN);
    if (!importId) throw new Error('後台 Preview 缺少 importId。');
    if (!/^[a-f0-9]{64}$/.test(migrationHash)) throw new Error('後台 Preview 缺少有效 migrationHash。');
    if (portfolio !== parsed.portfolio || sourceSha !== parsed.sourceWorkbookSha256 || eventCount !== parsed.eventCount) {
      throw new Error('後台 Preview 與本地 package 身份不一致，已停止確認。');
    }
    return { importId, migrationHash };
  }

  async function previewLegacyMigration() {
    const parsed = state.legacyPackage;
    if (!parsed || !parsed.eligible || parsed.portfolio !== state.portfolio) return;
    const button = $('preview-legacy'); const log = $('legacy-log');
    button.disabled = true; resetLegacyPreview();
    log.textContent = '正在由後台重放事件、核驗現金鏈與遷移 hash…';
    try {
      const result = await api('/api/admin/ledger/migration/preview', {
        method: 'POST', body: JSON.stringify(parsed.payload),
      });
      const receipt = validateLegacyPreview(result, parsed);
      state.legacyPreview = result;
      state.legacyImportId = receipt.importId;
      state.legacyMigrationHash = receipt.migrationHash;
      state.legacyConfirmed = String(first(result, ['importStatus', 'import_status'], '')).toUpperCase() === 'CONFIRMED';
      renderLegacyPreview(result);
      log.textContent = state.legacyConfirmed
        ? `✓ 此 source SHA 已完成遷移 · Import ${receipt.importId} · 可 Drain Outbox。`
        : `✓ 後台 Preview 已建立 · Import ${receipt.importId} · 請逐項確認後簽入。`;
    } catch (error) {
      log.textContent = '✗ ' + error.message;
      button.disabled = !state.legacyPackage || !state.legacyPackage.eligible;
    }
  }

  function renderLegacyPreview(result) {
    const exactDuplicates = Array.isArray(result.exactDuplicates) ? result.exactDuplicates : [];
    const eventCount = asNumber(first(result, ['eventCount', 'event_count'], 0), 0);
    renderLegacyStats($('legacy-preview-summary'), [
      ['EVENTS', eventCount],
      ['DUPLICATES', exactDuplicates.length],
    ]);
    $('legacy-import-id').textContent = state.legacyImportId;
    $('legacy-migration-hash').textContent = state.legacyMigrationHash;
    const previewNotes = [];
    if (result.duplicateUpload === true) previewNotes.push(`相同 portfolio + source SHA 已 Preview；沿用既有 importId（狀態 ${first(result, ['importStatus', 'import_status'], 'UNKNOWN')}）。`);
    renderLegacyMessages($('legacy-preview-messages'), [], [...previewNotes, ...(Array.isArray(result.warnings) ? result.warnings : [])]);
    state.legacyRequirements = {
      duplicates: exactDuplicates.length > 0,
    };
    LEGACY_ACKS.forEach(item => {
      const required = state.legacyRequirements[item.key] === true;
      $(item.input).checked = state.legacyConfirmed && required;
      $(item.input).disabled = !required || state.legacyConfirmed;
      $(item.row).classList.toggle('required', required);
      $(item.state).textContent = required ? (state.legacyConfirmed ? '已確認' : '必須勾選') : '不適用';
    });
    const phrase = legacyExpectedPhrase(result.portfolio);
    $('legacy-required-phrase').textContent = phrase;
    $('legacy-confirm-phrase').value = state.legacyConfirmed ? phrase : '';
    $('legacy-confirm-phrase').disabled = state.legacyConfirmed;
    $('legacy-preview').hidden = false;
    updateLegacyConfirmation();
  }

  function legacyAcknowledgement() {
    return Object.fromEntries(LEGACY_ACKS.map(item => [item.key, $(item.input).checked === true]));
  }

  function updateLegacyConfirmation() {
    const button = $('confirm-legacy'); const drain = $('drain-legacy-outbox');
    const status = $('legacy-confirm-state'); const phraseInput = $('legacy-confirm-phrase');
    if (!state.legacyPreview || !state.legacyRequirements) {
      button.disabled = true; drain.disabled = true; status.textContent = 'Preview 後才可確認。';
      return;
    }
    if (state.legacyConfirmed) {
      button.disabled = true; drain.disabled = false; phraseInput.removeAttribute('aria-invalid');
      status.textContent = '✓ 遷移已確認，賬本已刷新；可執行 Drain Outbox。';
      return;
    }
    const missing = LEGACY_ACKS.filter(item => state.legacyRequirements[item.key] && !$(item.input).checked);
    const expectedPhrase = legacyExpectedPhrase(state.portfolio);
    const phraseOk = phraseInput.value === expectedPhrase;
    phraseInput.setAttribute('aria-invalid', String(phraseInput.value.length > 0 && !phraseOk));
    button.disabled = missing.length > 0 || !phraseOk || !state.legacyImportId || !state.legacyMigrationHash;
    drain.disabled = true;
    if (missing.length) status.textContent = `還需勾選 ${missing.length} 項必要確認。`;
    else if (!phraseOk) status.textContent = `還需逐字輸入 ${expectedPhrase}。`;
    else status.textContent = '全部條件已滿足，可確認首次遷移。';
  }

  async function confirmLegacyMigration() {
    updateLegacyConfirmation();
    const button = $('confirm-legacy'); const log = $('legacy-log');
    if (button.disabled || !state.legacyImportId || !state.legacyMigrationHash) return;
    button.disabled = true; log.textContent = '正在以 migrationHash 原子簽入不可變事件…';
    try {
      const result = await api('/api/admin/ledger/migration/confirm', {
        method: 'POST',
        body: JSON.stringify({
          importId: state.legacyImportId,
          migrationHash: state.legacyMigrationHash,
          acknowledgement: {
            phrase: $('legacy-confirm-phrase').value,
            ...legacyAcknowledgement(),
          },
        }),
      });
      const portfolio = String(first(result, ['portfolio', 'portfolio_id'], '')).toLowerCase();
      const migrationHash = String(first(result, ['migrationHash', 'migration_hash'], '')).toLowerCase();
      if (portfolio !== state.portfolio || migrationHash !== state.legacyMigrationHash) throw new Error('Confirm 收據身份不一致，請立即停止後續操作。');
      state.legacyConfirmed = true;
      LEGACY_ACKS.forEach(item => { $(item.input).disabled = true; });
      $('legacy-confirm-phrase').disabled = true;
      log.textContent = `✓ 首次遷移已確認 · ${asNumber(first(result, ['eventCount', 'event_count'], 0), 0)} events · Ledger Revision ${asNumber(first(result, ['ledgerRevision', 'ledger_revision'], 0), 0)}。`;
      updateLegacyConfirmation();
      await loadLedger();
    } catch (error) {
      log.textContent = '✗ ' + error.message;
      updateLegacyConfirmation();
    }
  }

  async function drainLegacyOutbox() {
    if (!state.legacyConfirmed) return;
    const button = $('drain-legacy-outbox'); const log = $('legacy-log');
    let continuationPending = false;
    button.disabled = true; $('legacy-confirm-state').textContent = '正在處理 REBUILD_KV / RECALC_NAV / REBUILD_EXCEL…';
    try {
      const result = await api('/api/admin/ledger/outbox', {
        method: 'POST', body: JSON.stringify({ portfolio: state.portfolio }),
      });
      const rows = Array.isArray(result.results) ? result.results : [];
      const failed = rows.filter(item => item && item.ok === false);
      const continuation = rows.find(item => item && item.complete === false && item.ok !== false);
      continuationPending = result.pending === true || Boolean(continuation);
      const processed = asNumber(first(result, ['processed'], rows.length), rows.length);
      if (failed.length) {
        log.textContent = `✗ Outbox 已處理 ${processed} 項，其中 ${failed.length} 項失敗；請按錯誤重試。`;
      } else if (continuationPending) {
        const nextPhase = String(first(continuation || {}, ['nextPhase', 'phase'], '下一批'));
        const batchThrough = String(first(continuation || {}, ['batchThrough'], ''));
        log.textContent = `↻ 本批已完成 · processed ${processed} · 下一階段 ${nextPhase}${batchThrough ? `（已到 ${batchThrough}）` : ''}；請繼續 Drain。`;
      } else {
        log.textContent = `✓ Outbox drain 完成 · processed ${processed}${processed === 0 ? '（目前沒有待處理項）' : ''}。`;
      }
      await loadLedger();
    } catch (error) {
      log.textContent = '✗ Outbox drain 失敗：' + error.message;
    } finally {
      button.disabled = !state.legacyConfirmed;
      $('legacy-confirm-state').textContent = state.legacyConfirmed
        ? continuationPending ? '本批已完成；請繼續 Drain 直到全部完成。' : '遷移已確認；可再次 Drain 檢查剩餘項。'
        : 'Preview 後才可確認。';
    }
  }

  if (window.YC_LEDGER_TEST_MODE === true) {
    window.YCLedgerWorkbookTest = Object.freeze({
      INPUT_DEFS,
      DERIVED_SHEETS,
      buildRecordSheet,
      projectionRows,
      buildProjectionSheet,
      setSyncSheet,
      normalizeConfirmed,
      canonicalStyleManifest,
      remapGeneratedCellStyles,
      preserveTemplateWorkbookLayout,
      pipelineStatusView,
      eventRow,
      mergeExcelEvent,
      parseImportWorkbook,
      summarizeImportPreview,
      importConfirmationState,
      normalizeDividendCandidate,
      dividendVerifyPayload,
      dividendDismissPayload,
      dividendEvidenceEntries,
    });
  }

  async function init() {
    mountLedgerNavLink();
    bind();
    await loadLedger();
  }

  window.YCAdmin.gate(init);
})();
