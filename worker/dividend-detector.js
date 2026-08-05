/*
 * YiCapital dividend candidate detector.
 *
 * This module is intentionally a read-only discovery boundary:
 *   - it accepts the current holdings instead of reading the ledger database;
 *   - it never writes pending rows and never confirms ledger events;
 *   - provider amounts are used only as a cash-dividend presence signal;
 *   - every emitted amount is null and must be entered by an administrator.
 */

export const DIVIDEND_CANDIDATE_SCHEMA_VERSION = 'dividend-candidate-v1';
export const DIVIDEND_AMOUNT_STATUS = 'PENDING_VERIFICATION';

const PORTFOLIOS = new Set(['a', 'hk', 'us']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DATE = /^\d{8}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 4;
const TUSHARE_DIVIDEND_FIELDS = [
  'ts_code', 'end_date', 'ann_date', 'div_proc', 'cash_div',
  'record_date', 'ex_date', 'pay_date', 'imp_ann_date',
].join(',');

export class DividendDetectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DividendDetectionError';
    this.code = code;
  }
}

function detectorError(code, message) {
  return new DividendDetectionError(code, message);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function firstPresent(object, keys) {
  for (const key of keys) {
    if (own(object, key) && object[key] !== '' && object[key] != null) {
      return object[key];
    }
  }
  return undefined;
}

function isIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function cleanIsoDate(value, label) {
  const date = String(value || '').trim();
  if (!isIsoDate(date)) {
    throw detectorError('INVALID_DATE_WINDOW', `${label} must use YYYY-MM-DD`);
  }
  return date;
}

function optionalIsoDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const date = COMPACT_DATE.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw.slice(0, 10);
  if (!isIsoDate(date)) {
    return null;
  }
  return date;
}

function compactDate(value) {
  return String(value || '').replaceAll('-', '').slice(0, 8);
}

function addIsoDays(value, days) {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function inWindow(date, fromDate, toDate) {
  return Boolean(date && date >= fromDate && date <= toDate);
}

function normalizePortfolio(value) {
  const source = String(value || '').trim().toLowerCase();
  const aliases = {
    a: 'a',
    cn: 'a',
    china: 'a',
    'a-share': 'a',
    hk: 'hk',
    hongkong: 'hk',
    'hong-kong': 'hk',
    us: 'us',
    usa: 'us',
  };
  const portfolio = aliases[source];
  if (!portfolio || !PORTFOLIOS.has(portfolio)) {
    throw detectorError('INVALID_HOLDING_PORTFOLIO', 'holding portfolio must be a, hk or us');
  }
  return portfolio;
}

function normalizeAStockTicker(value) {
  const source = String(value || '').trim().toUpperCase();
  if (/^\d{6}\.SS$/.test(source)) return source.replace(/\.SS$/, '.SH');
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(source)) return source;
  if (!/^\d{6}$/.test(source)) {
    throw detectorError('INVALID_HOLDING_TICKER', 'A-share ticker must use a Tushare code');
  }
  const suffix = /^(4|8|92)/.test(source)
    ? 'BJ'
    : /^(5|6|900)/.test(source) ? 'SH' : 'SZ';
  return `${source}.${suffix}`;
}

function normalizeTicker(value, portfolio) {
  const source = String(value || '').trim().toUpperCase();
  if (!source) throw detectorError('INVALID_HOLDING_TICKER', 'holding ticker is required');
  if (portfolio === 'a') return normalizeAStockTicker(source);
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(source)) {
    throw detectorError('INVALID_HOLDING_TICKER', 'holding ticker is invalid');
  }
  return source;
}

function flattenHoldings(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') {
    throw detectorError('INVALID_HOLDINGS', 'holdings must be an array or portfolio map');
  }
  return Object.entries(input).flatMap(([portfolio, values]) => {
    if (!Array.isArray(values)) {
      throw detectorError('INVALID_HOLDINGS', 'each portfolio holding list must be an array');
    }
    return values.map(value => ({ ...value, portfolio: value?.portfolio || portfolio }));
  });
}

export function normalizeDividendHoldings(input) {
  const normalized = [];
  for (const raw of flattenHoldings(input)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw detectorError('INVALID_HOLDING', 'each holding must be an object');
    }
    const quantity = firstPresent(raw, ['quantity', 'q', 'shares', 'units']);
    if (quantity !== undefined) {
      const parsed = Number(quantity);
      if (!Number.isFinite(parsed)) {
        throw detectorError('INVALID_HOLDING_QUANTITY', 'holding quantity must be finite');
      }
      if (!(parsed > 0)) continue;
    }
    const portfolio = normalizePortfolio(firstPresent(raw, [
      'portfolio', 'portfolio_id', 'market',
    ]));
    const ticker = normalizeTicker(firstPresent(raw, [
      'ticker', 't', 'ts_code', 'symbol',
    ]), portfolio);
    const name = String(firstPresent(raw, ['name', 'n', 'security_name']) || ticker).trim() || ticker;
    normalized.push({ portfolio, ticker, name });
  }

  const bySecurity = new Map();
  normalized.forEach(holding => {
    const key = `${holding.portfolio}|${holding.ticker}`;
    const existing = bySecurity.get(key);
    if (!existing || (existing.name === existing.ticker && holding.name !== holding.ticker)) {
      bySecurity.set(key, holding);
    }
  });
  return [...bySecurity.values()].sort((left, right) =>
    left.portfolio.localeCompare(right.portfolio) || left.ticker.localeCompare(right.ticker));
}

function yahooSymbol(ticker, portfolio) {
  const source = String(ticker || '').trim().toUpperCase();
  if (portfolio === 'us') return source.replace(/\.US$/, '').replaceAll('.', '-');
  const base = source.replace(/\.HK$/, '');
  if (!/^\d{1,5}$/.test(base) || Number(base) <= 0) {
    throw detectorError('INVALID_HOLDING_TICKER', 'HK ticker must be numeric');
  }
  const compact = String(Number(base));
  return `${compact.padStart(4, '0')}.HK`;
}

function marketDate(timestampMs, portfolio) {
  const timeZone = portfolio === 'us' ? 'America/New_York' : 'Asia/Hong_Kong';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function implementedDividend(value) {
  const status = String(value || '').trim();
  return status.includes('实施') && !/(未实施|取消|终止)/.test(status);
}

function pendingCandidate({ portfolio, ticker, name, exDate, payDate, sourceEventId, evidence }) {
  return {
    schema_version: DIVIDEND_CANDIDATE_SCHEMA_VERSION,
    event_type: 'DIVIDEND',
    candidate_status: 'PENDING',
    portfolio,
    ticker,
    name,
    ex_date: exDate || null,
    pay_date: payDate || null,
    source_event_id: sourceEventId,
    amount: null,
    amount_status: DIVIDEND_AMOUNT_STATUS,
    action_required: 'VERIFY_AND_ENTER_AMOUNT',
    dedupe_key: `${portfolio}|${ticker}|${sourceEventId}`,
    evidence,
  };
}

async function tushareCandidates(adapter, holding, fromDate, toDate) {
  if (!adapter || typeof adapter.query !== 'function') {
    throw detectorError('TUSHARE_ADAPTER_REQUIRED', 'Tushare adapter is required for A-share holdings');
  }
  const result = await adapter.query('dividend', {
    params: { ts_code: holding.ticker },
    fields: TUSHARE_DIVIDEND_FIELDS,
  });
  if (result?.is_complete === false) {
    throw detectorError(
      'TUSHARE_DIVIDEND_SIGNAL_INCOMPLETE',
      'Tushare dividend signal reached an incomplete result boundary',
    );
  }
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.flatMap(row => {
    const rowTicker = normalizeTicker(row?.ts_code || holding.ticker, 'a');
    if (rowTicker !== holding.ticker || !implementedDividend(row?.div_proc)) return [];
    const exDate = optionalIsoDate(row?.ex_date);
    const payDate = optionalIsoDate(row?.pay_date);
    const declaredCashSignal = Number(row?.cash_div) > 0;
    if ((!declaredCashSignal && !payDate) ||
        (!inWindow(exDate, fromDate, toDate) && !inWindow(payDate, fromDate, toDate))) {
      return [];
    }
    const endDate = optionalIsoDate(row?.end_date);
    const annDate = optionalIsoDate(row?.ann_date);
    const recordDate = optionalIsoDate(row?.record_date);
    const implementationAnnouncementDate = optionalIsoDate(row?.imp_ann_date);
    const anchorDate = exDate || payDate;
    const sourceEventId = [
      'tushare', 'dividend', holding.ticker,
      compactDate(endDate) || 'na', compactDate(anchorDate),
      compactDate(annDate || implementationAnnouncementDate) || 'na',
    ].join(':');
    return [pendingCandidate({
      ...holding,
      exDate,
      payDate,
      sourceEventId,
      evidence: {
        provider: 'Tushare Pro',
        source: 'tushare:dividend',
        source_endpoint: 'dividend',
        source_doc_url: result?.source_doc_url || 'https://tushare.pro/document/2?doc_id=103',
        fetched_at: result?.fetched_at || result?.retrieved_at || null,
        announcement_date: annDate,
        record_date: recordDate,
        implementation_announcement_date: implementationAnnouncementDate,
        implementation_status: String(row?.div_proc || '').trim() || null,
        cash_distribution_signal: true,
      },
    })];
  });
}

async function fetchYahooPayload(fetchImpl, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const timeoutSignal = typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(10000)
        : undefined;
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 YiCapital/1.0' },
        ...(timeoutSignal ? { signal: timeoutSignal } : {}),
      });
      if (!response || response.ok !== true || typeof response.json !== 'function') {
        throw detectorError('YAHOO_DIVIDEND_HTTP_UNAVAILABLE', 'Yahoo dividend signal is unavailable');
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  const error = detectorError('YAHOO_DIVIDEND_HTTP_UNAVAILABLE', 'Yahoo dividend signal is unavailable');
  error.cause = lastError;
  throw error;
}

async function yahooCandidates(fetchImpl, holding, fromDate, toDate, now) {
  if (typeof fetchImpl !== 'function') {
    throw detectorError('FETCH_REQUIRED', 'Fetch is required for US/HK dividend detection');
  }
  const symbol = yahooSymbol(holding.ticker, holding.portfolio);
  const startMs = Date.parse(`${fromDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${addIsoDays(toDate, 2)}T00:00:00.000Z`);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${Math.floor(startMs / 1000)}&period2=${Math.floor(endMs / 1000)}` +
    '&interval=1d&includePrePost=false&events=div&includeAdjustedClose=false';
  const payload = await fetchYahooPayload(fetchImpl, url);
  const result = payload?.chart && Array.isArray(payload.chart.result)
    ? payload.chart.result[0]
    : null;
  if (!result || payload?.chart?.error) {
    throw detectorError('YAHOO_DIVIDEND_PAYLOAD_INVALID', 'Yahoo dividend signal is invalid');
  }
  const fetchedAt = new Date(now()).toISOString();
  const dividends = Object.entries(result?.events?.dividends || {});
  return dividends.flatMap(([providerEventKey, event]) => {
    const seconds = Number(event?.date ?? providerEventKey);
    if (!Number.isFinite(seconds) || seconds <= 0) return [];
    const exDate = marketDate(seconds * 1000, holding.portfolio);
    if (!inWindow(exDate, fromDate, toDate)) return [];
    const sourceEventId = `yahoo:query2-chart:${symbol}:dividend:${Math.trunc(seconds)}`;
    return [pendingCandidate({
      ...holding,
      exDate,
      payDate: null,
      sourceEventId,
      evidence: {
        provider: 'Yahoo Finance',
        source: 'yahoo:query2-chart',
        source_endpoint: 'query2.finance.yahoo.com/v8/finance/chart',
        source_url: url,
        source_symbol: symbol,
        provider_event_key: String(providerEventKey),
        provider_event_timestamp: Math.trunc(seconds),
        event_date_semantics: 'ex_date',
        fetched_at: fetchedAt,
      },
    })];
  });
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        output[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (reason) {
        output[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  return output;
}

function safeErrorCode(error, holding) {
  const code = String(error?.code || '').trim();
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code;
  return holding.portfolio === 'a'
    ? 'TUSHARE_DIVIDEND_SIGNAL_UNAVAILABLE'
    : 'YAHOO_DIVIDEND_SIGNAL_UNAVAILABLE';
}

/**
 * Discover cash-dividend signals for current positive holdings.
 *
 * The caller supplies the holdings and later decides how to persist candidates.
 * `candidates` are safe to enqueue for review but are never safe to confirm:
 * their amount is deliberately null.
 */
export async function detectDividendCandidates(options = {}) {
  const fromDate = cleanIsoDate(options.fromDate, 'fromDate');
  const toDate = cleanIsoDate(options.toDate, 'toDate');
  if (fromDate > toDate) {
    throw detectorError('INVALID_DATE_WINDOW', 'fromDate must not be after toDate');
  }
  const holdings = normalizeDividendHoldings(options.holdings || []);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const generatedAtMs = now();
  const requestedConcurrency = Number(options.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 ||
      requestedConcurrency > 8) {
    throw detectorError('INVALID_CONCURRENCY', 'concurrency must be an integer between 1 and 8');
  }

  const settled = await mapLimit(holdings, requestedConcurrency, holding =>
    holding.portfolio === 'a'
      ? tushareCandidates(options.tushareAdapter, holding, fromDate, toDate)
      : yahooCandidates(fetchImpl, holding, fromDate, toDate, () => generatedAtMs));
  const candidatesByKey = new Map();
  const errors = [];
  settled.forEach((result, index) => {
    const holding = holdings[index];
    if (result.status === 'rejected') {
      errors.push({
        portfolio: holding.portfolio,
        ticker: holding.ticker,
        code: safeErrorCode(result.reason, holding),
      });
      return;
    }
    result.value.forEach(candidate => candidatesByKey.set(candidate.dedupe_key, candidate));
  });
  const candidates = [...candidatesByKey.values()].sort((left, right) =>
    String(left.ex_date || left.pay_date).localeCompare(String(right.ex_date || right.pay_date)) ||
    left.portfolio.localeCompare(right.portfolio) ||
    left.ticker.localeCompare(right.ticker) ||
    left.source_event_id.localeCompare(right.source_event_id));

  return {
    schema_version: 'dividend-detection-run-v1',
    generated_at: new Date(generatedAtMs).toISOString(),
    window: { from_date: fromDate, to_date: toDate },
    checked_holdings: holdings.length,
    failed_holdings: errors.length,
    is_complete: errors.length === 0,
    candidates,
    errors,
  };
}
