/*
 * YiCapital Terminal — production Tushare Pro REST adapter.
 *
 * Security boundary:
 *   - TUSHARE_TOKEN is read only from the Worker env binding.
 *   - The upstream URL is fixed to Tushare's official HTTPS REST endpoint.
 *   - Browser input can select only explicitly whitelisted datasets/parameters.
 *   - Public errors never include upstream bodies, request bodies, or secrets.
 *
 * Supply-chain data is intentionally not sourced from Tushare. Callers inject a
 * warehouse adapter for Supply/bootstrap/stock-detail integration.
 */

export const TUSHARE_API_URL = 'https://api.tushare.pro';

export const FRESHNESS_CLASSES = Object.freeze([
  'static',
  'disclosure',
  'macro_release',
  'eod',
  'news_incremental',
  'intraday_snapshot',
  'live_minute_bar',
]);

const FRESHNESS_SET = new Set(FRESHNESS_CLASSES);
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const endpoint = (domain, freshnessClass, ttlSeconds, maxRows, params, docId) => ({
  domain,
  freshness_class: freshnessClass,
  ttl_seconds: ttlSeconds,
  max_rows: maxRows,
  params,
  source_doc_url: docId
    ? `https://tushare.pro/document/2?doc_id=${docId}`
    : 'https://tushare.pro/document/1?doc_id=130',
});

const ENDPOINT_DEFINITIONS = {
  // Market
  trade_cal: endpoint('Market', 'static', DAY, 10000, [
    'exchange', 'start_date', 'end_date', 'is_open',
  ]),
  index_basic: endpoint('Market', 'static', DAY, 10000, [
    'ts_code', 'name', 'market', 'publisher', 'category',
  ]),
  index_daily: endpoint('Market', 'eod', 15 * MINUTE, 8000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 95),
  index_dailybasic: endpoint('Market', 'eod', 30 * MINUTE, 3000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 128),
  index_global: endpoint('Market', 'eod', 30 * MINUTE, 4000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 211),
  rt_idx_k: endpoint('Market', 'intraday_snapshot', MINUTE, 10000, [
    'ts_code',
  ]),

  // Stocks
  stock_basic: endpoint('Stocks', 'static', DAY, 6000, [
    'ts_code', 'name', 'market', 'list_status', 'exchange', 'is_hs',
  ], 25),
  daily: endpoint('Stocks', 'eod', 15 * MINUTE, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 27),
  daily_basic: endpoint('Stocks', 'eod', 30 * MINUTE, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 32),
  adj_factor: endpoint('Stocks', 'eod', HOUR, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ]),
  income: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period',
    'report_type', 'comp_type',
  ], 33),
  balancesheet: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period',
    'report_type', 'comp_type',
  ], 36),
  cashflow: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period',
    'report_type', 'comp_type',
  ], 44),
  fina_indicator: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period',
  ], 79),
  forecast: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period', 'type',
  ], 45),
  express: endpoint('Stocks', 'disclosure', HOUR, 6000, [
    'ts_code', 'ann_date', 'start_date', 'end_date', 'period',
  ], 46),
  disclosure_date: endpoint('Stocks', 'disclosure', 6 * HOUR, 3000, [
    'ts_code', 'end_date', 'pre_date', 'actual_date',
  ], 162),
  rt_k: endpoint('Stocks', 'intraday_snapshot', MINUTE, 10000, [
    'ts_code',
  ], 372),
  rt_min: endpoint('Stocks', 'live_minute_bar', MINUTE, 300, [
    'ts_code', 'freq', 'start_time', 'end_time',
  ], 374),
  hk_basic: endpoint('Stocks', 'static', DAY, 6000, [
    'ts_code', 'list_status',
  ], 191),
  hk_daily: endpoint('Stocks', 'eod', 30 * MINUTE, 5000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 192),
  us_basic: endpoint('Stocks', 'static', DAY, 6000, [
    'ts_code', 'classify', 'offset', 'limit',
  ], 252),
  us_daily: endpoint('Stocks', 'eod', 30 * MINUTE, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 254),

  // Debt
  cb_basic: endpoint('Debt', 'static', DAY, 3000, [
    'ts_code', 'list_date', 'exchange',
  ], 185),
  cb_issue: endpoint('Debt', 'disclosure', 6 * HOUR, 3000, [
    'ts_code', 'ann_date', 'start_date', 'end_date',
  ], 186),
  cb_daily: endpoint('Debt', 'eod', 30 * MINUTE, 2000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 187),
  cb_redeem: endpoint('Debt', 'disclosure', 6 * HOUR, 3000, [
    'ts_code', 'ann_date', 'start_date', 'end_date',
  ], 208),
  repo_daily: endpoint('Debt', 'eod', HOUR, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 256),
  yc_cb: endpoint('Debt', 'macro_release', 6 * HOUR, 6000, [
    'curve_type', 'trade_date', 'start_date', 'end_date',
  ], 201),

  // ETF
  etf_basic: endpoint('ETF', 'static', DAY, 15000, [
    'ts_code', 'index_code', 'list_status', 'exchange',
  ], 385),
  fund_basic: endpoint('ETF', 'static', DAY, 15000, [
    'ts_code', 'market', 'status',
  ], 19),
  fund_daily: endpoint('ETF', 'eod', 30 * MINUTE, 2000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 127),
  fund_adj: endpoint('ETF', 'eod', HOUR, 2000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 199),
  etf_share_size: endpoint('ETF', 'eod', 6 * HOUR, 5000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 408),
  rt_etf_k: endpoint('ETF', 'intraday_snapshot', MINUTE, 10000, [
    'ts_code',
  ], 415),
  rt_etf_min: endpoint('ETF', 'live_minute_bar', MINUTE, 300, [
    'ts_code', 'freq', 'start_time', 'end_time',
  ], 416),

  // Derivatives
  fut_basic: endpoint('Derivatives', 'static', DAY, 10000, [
    'exchange', 'fut_type', 'ts_code',
  ], 135),
  fut_daily: endpoint('Derivatives', 'eod', 30 * MINUTE, 2000, [
    'trade_date', 'ts_code', 'exchange', 'start_date', 'end_date',
  ], 138),
  fut_mapping: endpoint('Derivatives', 'eod', 6 * HOUR, 6000, [
    'ts_code', 'trade_date', 'start_date', 'end_date',
  ], 189),
  fut_wsr: endpoint('Derivatives', 'eod', 6 * HOUR, 2000, [
    'trade_date', 'symbol', 'start_date', 'end_date', 'exchange',
  ], 139),
  fut_holding: endpoint('Derivatives', 'eod', 6 * HOUR, 2000, [
    'trade_date', 'symbol', 'start_date', 'end_date', 'exchange',
  ], 140),
  opt_basic: endpoint('Derivatives', 'static', DAY, 10000, [
    'exchange', 'ts_code', 'call_put',
  ], 158),
  opt_daily: endpoint('Derivatives', 'eod', 30 * MINUTE, 1000, [
    'trade_date', 'ts_code', 'exchange', 'start_date', 'end_date',
  ], 159),
  rt_fut_min: endpoint('Derivatives', 'live_minute_bar', MINUTE, 300, [
    'ts_code', 'freq', 'start_time', 'end_time',
  ], 340),

  // Money & Currency
  fx_obasic: endpoint('Money & Currency', 'static', DAY, 5000, [
    'exchange', 'classify', 'ts_code',
  ], 178),
  fx_daily: endpoint('Money & Currency', 'eod', HOUR, 1000, [
    'ts_code', 'trade_date', 'start_date', 'end_date', 'exchange',
  ], 179),
  shibor: endpoint('Money & Currency', 'macro_release', HOUR, 2000, [
    'date', 'start_date', 'end_date',
  ], 149),
  shibor_quote: endpoint('Money & Currency', 'macro_release', HOUR, 4000, [
    'date', 'bank', 'start_date', 'end_date',
  ], 150),
  shibor_lpr: endpoint('Money & Currency', 'macro_release', HOUR, 2000, [
    'date', 'start_date', 'end_date',
  ], 151),
  libor: endpoint('Money & Currency', 'macro_release', 6 * HOUR, 2000, [
    'date', 'curr_type', 'start_date', 'end_date',
  ], 152),
  hibor: endpoint('Money & Currency', 'macro_release', 6 * HOUR, 2000, [
    'date', 'start_date', 'end_date',
  ], 153),
  cn_m: endpoint('Money & Currency', 'macro_release', 6 * HOUR, 2000, [
    'month', 'start_m', 'end_m',
  ], 242),
  sf_month: endpoint('Money & Currency', 'macro_release', 6 * HOUR, 2000, [
    'month', 'start_m', 'end_m',
  ], 243),
  us_tycr: endpoint('Money & Currency', 'macro_release', 6 * HOUR, 2000, [
    'date', 'start_date', 'end_date',
  ], 219),

  // News is a cross-domain Terminal surface.
  news: endpoint('News', 'news_incremental', MINUTE, 1500, [
    'start_date', 'end_date', 'src',
  ], 143),
  major_news: endpoint('News', 'news_incremental', 5 * MINUTE, 400, [
    'src', 'start_date', 'end_date',
  ], 195),
  anns_d: endpoint('News', 'disclosure', 5 * MINUTE, 2000, [
    'ts_code', 'ann_date', 'start_date', 'end_date',
  ], 176),
};

export const TUSHARE_ENDPOINTS = Object.freeze(
  Object.fromEntries(
    Object.entries(ENDPOINT_DEFINITIONS).map(([name, value]) => [
      name,
      Object.freeze({ ...value, params: Object.freeze([...value.params]) }),
    ]),
  ),
);

export const TERMINAL_DOMAINS = Object.freeze([
  'Market',
  'Stocks',
  'Debt',
  'Supply',
  'ETF',
  'Derivatives',
  'Money & Currency',
]);

const DOMAIN_SET = new Set(TERMINAL_DOMAINS);
const ROUTES = Object.freeze([
  '/api/terminal/bootstrap',
  '/api/terminal/search',
  '/api/terminal/market',
  '/api/terminal/news',
  '/api/terminal/quote',
  '/api/terminal/history',
  '/api/terminal/stock-detail',
  '/api/terminal/status',
]);
const ROUTE_SET = new Set(ROUTES);
const QUOTE_ENDPOINTS = Object.freeze({
  stock: 'daily',
  stocks: 'daily',
  'a-stock': 'daily',
  'hk-stock': 'hk_daily',
  'us-stock': 'us_daily',
  index: 'index_daily',
  market: 'index_daily',
  'global-index': 'index_global',
  debt: 'cb_daily',
  bond: 'cb_daily',
  etf: 'fund_daily',
  fund: 'fund_daily',
  future: 'fut_daily',
  futures: 'fut_daily',
  option: 'opt_daily',
  options: 'opt_daily',
  fx: 'fx_daily',
  currency: 'fx_daily',
});

const DEFAULT_MARKET_ENDPOINT = Object.freeze({
  Market: 'index_daily',
  Stocks: 'daily',
  Debt: 'cb_daily',
  ETF: 'fund_daily',
  Derivatives: 'fut_daily',
  'Money & Currency': 'shibor',
});

// These statement and estimate datasets may be used only by controlled
// ingestion/reconciliation jobs. They are deliberately excluded from the
// browser-facing market route so FA remains authoritative from the filing
// warehouse instead of silently mixing Tushare statement history into it.
const WAREHOUSE_ONLY_DATASETS = new Set([
  'income',
  'balancesheet',
  'cashflow',
  'fina_indicator',
  'forecast',
  'express',
  'disclosure_date',
]);

export class TushareAdapterError extends Error {
  constructor(code, message, status = 500, freshnessClass = 'static') {
    super(message);
    this.name = 'TushareAdapterError';
    this.code = code;
    this.status = status;
    this.freshness_class = FRESHNESS_SET.has(freshnessClass)
      ? freshnessClass
      : 'static';
  }
}

const adapterError = (code, message, status, freshnessClass) =>
  new TushareAdapterError(code, message, status, freshnessClass);

function nowIso(now) {
  return new Date(now()).toISOString();
}

function compactDate(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function chinaDateTime(date) {
  // China has no daylight-saving offset; shifting before ISO formatting is deterministic.
  return new Date(date.getTime() + 8 * HOUR * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function cleanDate(value, label) {
  const normalized = String(value || '').replaceAll('-', '');
  if (!/^\d{8}$/.test(normalized)) {
    throw adapterError('INVALID_DATE', `${label} must use YYYYMMDD`, 400);
  }
  return normalized;
}

function cleanDateTime(value, label) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    throw adapterError(
      'INVALID_DATETIME',
      `${label} must use YYYY-MM-DD HH:mm:ss`,
      400,
      'news_incremental',
    );
  }
  return normalized;
}

function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) {
    throw adapterError('INVALID_SYMBOL', 'A valid symbol is required', 400);
  }
  return symbol;
}

function cleanLimit(value, fallback = 100, maximum = 1000) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw adapterError('INVALID_LIMIT', `limit must be between 1 and ${maximum}`, 400);
  }
  return parsed;
}

function cleanFields(value) {
  if (value == null || value === '') return '';
  const fields = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!fields.length || fields.length > 80 ||
      fields.some((field) => !/^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(field))) {
    throw adapterError('INVALID_FIELDS', 'fields contains an unsupported identifier', 400);
  }
  return fields.join(',');
}

function normalizeDomain(value) {
  const input = String(value || 'Market').trim().toLowerCase().replace(/\s+/g, ' ');
  const aliases = {
    market: 'Market',
    stocks: 'Stocks',
    stock: 'Stocks',
    debt: 'Debt',
    bond: 'Debt',
    supply: 'Supply',
    etf: 'ETF',
    derivatives: 'Derivatives',
    derivative: 'Derivatives',
    'money & currency': 'Money & Currency',
    'money and currency': 'Money & Currency',
    money: 'Money & Currency',
    currency: 'Money & Currency',
  };
  const domain = aliases[input];
  if (!domain || !DOMAIN_SET.has(domain)) {
    throw adapterError('INVALID_DOMAIN', 'Unsupported Terminal domain', 400);
  }
  return domain;
}

function normalizeAsset(value) {
  const asset = String(value || 'stock').trim().toLowerCase();
  const apiName = QUOTE_ENDPOINTS[asset];
  if (!apiName) {
    throw adapterError('INVALID_ASSET', 'Unsupported quote/history asset', 400);
  }
  return { asset, apiName };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeCacheKey(apiName, params, fields) {
  return `tushare:v1:${apiName}:${fnv1a(stableStringify({ fields, params }))}`;
}

function sanitizeParams(apiName, params) {
  const config = TUSHARE_ENDPOINTS[apiName];
  if (!config) {
    throw adapterError('ENDPOINT_NOT_ALLOWED', 'Tushare endpoint is not allowed', 400);
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw adapterError(
      'INVALID_PARAMS',
      'params must be an object',
      400,
      config.freshness_class,
    );
  }
  const allowed = new Set(config.params);
  const output = {};
  for (const [key, rawValue] of Object.entries(params)) {
    if (key === 'token' || key === 'api_name' || !allowed.has(key)) {
      throw adapterError(
        'PARAM_NOT_ALLOWED',
        `Parameter is not allowed for ${apiName}`,
        400,
        config.freshness_class,
      );
    }
    if (rawValue == null || rawValue === '') continue;
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) {
      throw adapterError(
        'INVALID_PARAM_VALUE',
        `Invalid parameter for ${apiName}`,
        400,
        config.freshness_class,
      );
    }
    const value = String(rawValue).trim();
    if (value.length > 500) {
      throw adapterError(
        'INVALID_PARAM_VALUE',
        `Invalid parameter for ${apiName}`,
        400,
        config.freshness_class,
      );
    }
    output[key] = value;
  }
  return output;
}

function rowsFromTushare(data, freshnessClass) {
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.items) ||
      data.fields.some((field) => typeof field !== 'string') ||
      data.items.some((item) => !Array.isArray(item))) {
    throw adapterError(
      'UPSTREAM_SCHEMA_INVALID',
      'Tushare returned an invalid response',
      502,
      freshnessClass,
    );
  }
  return data.items.map((item) => Object.fromEntries(
    data.fields.map((field, index) => [field, item[index] ?? null]),
  ));
}

function inferAsOf(rows, fallback) {
  const candidates = [];
  const keys = [
    'datetime', 'pub_time', 'ann_date', 'f_ann_date', 'trade_date',
    'end_date', 'actual_date', 'date', 'month', 'list_date',
  ];
  rows.forEach((row) => {
    keys.forEach((key) => {
      const value = row && row[key];
      if (value != null && value !== '') candidates.push(String(value));
    });
  });
  return candidates.sort().at(-1) || fallback;
}

function rowDateValue(row) {
  return String(
    row?.datetime ?? row?.pub_time ?? row?.trade_date ??
    row?.ann_date ?? row?.date ?? row?.month ?? '',
  );
}

function freshnessForEndpoint(apiName) {
  return TUSHARE_ENDPOINTS[apiName]?.freshness_class || 'static';
}

function permissionFailure(code, message) {
  return Number(code) === 2002 ||
    /permission|privilege|权限|积分|单独开通|没有访问/i.test(String(message || ''));
}

function credentialFailure(code, message) {
  return Number(code) === -2001 ||
    /token|凭证|认证|authenticat|unauthor/i.test(String(message || ''));
}

async function readKv(cache, key) {
  if (!cache || typeof cache.get !== 'function') return null;
  try {
    const value = await cache.get(key, 'json');
    if (typeof value === 'string') return JSON.parse(value);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

async function writeKv(cache, key, value, ttlSeconds) {
  if (!cache || typeof cache.put !== 'function') return false;
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    return true;
  } catch (_) {
    return false;
  }
}

function tokenFromEnv(env) {
  const token = typeof env?.TUSHARE_TOKEN === 'string'
    ? env.TUSHARE_TOKEN.trim()
    : '';
  if (!token) {
    throw adapterError(
      'TUSHARE_NOT_CONFIGURED',
      'Tushare data is not configured',
      503,
    );
  }
  return token;
}

function publicError(error, fallbackFreshness = 'static') {
  if (error instanceof TushareAdapterError) return error;
  return adapterError(
    'TUSHARE_ADAPTER_FAILURE',
    'Tushare data is temporarily unavailable',
    502,
    fallbackFreshness,
  );
}

async function callWarehouse(warehouse, method, payload, freshnessClass = 'disclosure') {
  const fn = warehouse && warehouse[method];
  if (typeof fn !== 'function') {
    throw adapterError(
      'WAREHOUSE_UNAVAILABLE',
      'Supply warehouse is unavailable',
      503,
      freshnessClass,
    );
  }
  let result;
  try {
    result = await fn(payload);
  } catch (_) {
    throw adapterError(
      'WAREHOUSE_UNAVAILABLE',
      'Supply warehouse is unavailable',
      503,
      freshnessClass,
    );
  }
  if (!result || result.ok === false) {
    throw adapterError(
      'WAREHOUSE_UNAVAILABLE',
      'Supply warehouse is unavailable',
      503,
      freshnessClass,
    );
  }
  return result;
}

function warehouseFreshness(result, fallback) {
  const value = result?.freshness_class || fallback;
  if (!FRESHNESS_SET.has(value)) {
    throw adapterError(
      'WAREHOUSE_SCHEMA_INVALID',
      'Supply warehouse returned an invalid freshness class',
      502,
      fallback,
    );
  }
  return value;
}

function limitedEnvelope(result, limit) {
  const rows = Array.isArray(result.data) ? result.data : [];
  const truncated = rows.length > limit;
  return {
    ...result,
    data: rows.slice(0, limit),
    row_count: Math.min(rows.length, limit),
    is_complete: result.is_complete === true && !truncated,
    warnings: truncated
      ? [...(result.warnings || []), 'route_limit_applied']
      : (result.warnings || []),
  };
}

export function createTushareAdapter(env, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw adapterError('FETCH_UNAVAILABLE', 'Fetch is unavailable', 500);
  }
  const cache = options.cache || env?.TUSHARE_CACHE || env?.YC_KV || null;
  const warehouse = options.warehouse || null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requestedTimeout = Number(options.timeoutMs ?? 8000);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(30000, Math.max(10, requestedTimeout))
    : 8000;

  async function query(apiName, request = {}) {
    const config = TUSHARE_ENDPOINTS[apiName];
    if (!config) {
      throw adapterError('ENDPOINT_NOT_ALLOWED', 'Tushare endpoint is not allowed', 400);
    }
    const params = sanitizeParams(apiName, request.params || {});
    const fields = cleanFields(request.fields || '');
    const key = makeCacheKey(apiName, params, fields);
    const retrievedAt = nowIso(now);
    const currentMs = new Date(retrievedAt).getTime();
    const cached = await readKv(cache, key);
    if (cached && cached.schema_version === 1 &&
        cached.endpoint === apiName &&
        Number(cached.expires_at_ms) > currentMs &&
        Array.isArray(cached.data)) {
      return {
        ok: true,
        domain: config.domain,
        dataset: apiName,
        data: cached.data,
        fields: Array.isArray(cached.fields) ? cached.fields : [],
        row_count: cached.data.length,
        source_endpoint: apiName,
        source_doc_url: config.source_doc_url,
        fetched_at: cached.fetched_at,
        retrieved_at: retrievedAt,
        as_of: cached.as_of,
        freshness_class: config.freshness_class,
        entitlement_status: 'available',
        is_complete: cached.is_complete === true,
        warnings: Array.isArray(cached.warnings) ? cached.warnings : [],
        cache_status: 'hit',
      };
    }

    const token = tokenFromEnv(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(TUSHARE_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_name: apiName,
          token,
          params,
          fields,
        }),
        signal: controller.signal,
      });
    } catch (_) {
      if (controller.signal.aborted) {
        throw adapterError(
          'TUSHARE_TIMEOUT',
          'Tushare request timed out',
          504,
          config.freshness_class,
        );
      }
      throw adapterError(
        'TUSHARE_UPSTREAM_UNAVAILABLE',
        'Tushare data is temporarily unavailable',
        502,
        config.freshness_class,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response || !response.ok) {
      throw adapterError(
        'TUSHARE_UPSTREAM_HTTP',
        'Tushare data is temporarily unavailable',
        502,
        config.freshness_class,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw adapterError(
        'TUSHARE_UPSTREAM_INVALID_JSON',
        'Tushare returned an invalid response',
        502,
        config.freshness_class,
      );
    }
    if (!payload || Number(payload.code) !== 0) {
      if (permissionFailure(payload?.code, payload?.msg)) {
        throw adapterError(
          'TUSHARE_PERMISSION_DENIED',
          'Tushare permission is unavailable for this dataset',
          403,
          config.freshness_class,
        );
      }
      if (credentialFailure(payload?.code, payload?.msg)) {
        throw adapterError(
          'TUSHARE_AUTH_FAILED',
          'Tushare credentials are unavailable',
          503,
          config.freshness_class,
        );
      }
      throw adapterError(
        'TUSHARE_UPSTREAM_REJECTED',
        'Tushare rejected the data request',
        502,
        config.freshness_class,
      );
    }

    const data = rowsFromTushare(payload.data, config.freshness_class);
    const fetchedAt = nowIso(now);
    const asOf = inferAsOf(data, fetchedAt);
    const warnings = data.length >= config.max_rows ? ['row_limit_reached'] : [];
    const isComplete = data.length < config.max_rows;
    const cacheRecord = {
      schema_version: 1,
      endpoint: apiName,
      fields: payload.data.fields,
      data,
      fetched_at: fetchedAt,
      as_of: asOf,
      is_complete: isComplete,
      warnings,
      expires_at_ms: new Date(fetchedAt).getTime() + config.ttl_seconds * 1000,
    };
    const cachedSuccessfully = await writeKv(
      cache,
      key,
      cacheRecord,
      config.ttl_seconds,
    );
    return {
      ok: true,
      domain: config.domain,
      dataset: apiName,
      data,
      fields: payload.data.fields,
      row_count: data.length,
      source_endpoint: apiName,
      source_doc_url: config.source_doc_url,
      fetched_at: fetchedAt,
      retrieved_at: fetchedAt,
      as_of: asOf,
      freshness_class: config.freshness_class,
      entitlement_status: 'available',
      is_complete: isComplete,
      warnings,
      cache_status: cachedSuccessfully ? 'miss' : 'bypass',
    };
  }

  return Object.freeze({
    query,
    warehouse,
    cacheConfigured: Boolean(cache && typeof cache.get === 'function'),
    warehouseConfigured: Boolean(warehouse),
    tokenConfigured: Boolean(
      typeof env?.TUSHARE_TOKEN === 'string' && env.TUSHARE_TOKEN.trim(),
    ),
    timeoutMs,
  });
}

function routeParams(url, apiName, aliases = {}) {
  const config = TUSHARE_ENDPOINTS[apiName];
  const params = {};
  config.params.forEach((key) => {
    const queryKey = Object.entries(aliases).find(([, target]) => target === key)?.[0] || key;
    const value = url.searchParams.get(queryKey) ?? url.searchParams.get(key);
    if (value != null && value !== '') params[key] = value;
  });
  return params;
}

function assertNoSensitiveQuery(url) {
  if (url.searchParams.has('token') || url.searchParams.has('api_name')) {
    throw adapterError('SENSITIVE_QUERY_REJECTED', 'Sensitive query parameters are not allowed', 400);
  }
}

function assertAllowedQueryKeys(url, keys, freshnessClass = 'static') {
  const allowed = new Set(keys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw adapterError(
        'QUERY_PARAMETER_NOT_ALLOWED',
        'Unsupported query parameter',
        400,
        freshnessClass,
      );
    }
  }
}

function recentDateRange(now, days) {
  const end = new Date(now());
  const start = new Date(end.getTime() - days * DAY * 1000);
  return { start_date: compactDate(start), end_date: compactDate(end) };
}

function dateRangeFromUrl(url, now, required) {
  const startValue = url.searchParams.get('start') || url.searchParams.get('start_date');
  const endValue = url.searchParams.get('end') || url.searchParams.get('end_date');
  if (!startValue || !endValue) {
    if (required) {
      throw adapterError('DATE_RANGE_REQUIRED', 'start and end dates are required', 400);
    }
    return recentDateRange(now, 14);
  }
  const startDate = cleanDate(startValue, 'start');
  const endDate = cleanDate(endValue, 'end');
  if (startDate > endDate) {
    throw adapterError('INVALID_DATE_RANGE', 'start must not be after end', 400);
  }
  const startMs = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(4, 6)) - 1,
    Number(startDate.slice(6, 8)),
  );
  const endMs = Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(4, 6)) - 1,
    Number(endDate.slice(6, 8)),
  );
  if (endMs - startMs > 20 * 366 * DAY * 1000) {
    throw adapterError('DATE_RANGE_TOO_LARGE', 'date range exceeds 20 years', 400);
  }
  return { start_date: startDate, end_date: endDate };
}

function ensureRows(result, freshnessClass) {
  if (!result || !Array.isArray(result.data) || !result.data.length) {
    throw adapterError('NO_DATA', 'No published data is available for this request', 404, freshnessClass);
  }
  return result;
}

function publicCatalog() {
  return TERMINAL_DOMAINS.map((domain) => ({
    domain,
    source: domain === 'Supply' ? 'warehouse' : 'tushare',
    datasets: domain === 'Supply'
      ? []
      : Object.entries(TUSHARE_ENDPOINTS)
        .filter(([name, config]) =>
          config.domain === domain && !WAREHOUSE_ONLY_DATASETS.has(name))
        .map(([name, config]) => ({
          name,
          freshness_class: config.freshness_class,
        })),
  }));
}

async function routeBootstrap(adapter, request, now) {
  if (!adapter.tokenConfigured) {
    throw adapterError(
      'TUSHARE_NOT_CONFIGURED',
      'Tushare data is not configured',
      503,
    );
  }
  const supply = await callWarehouse(adapter.warehouse, 'bootstrap', { request }, 'static');
  return {
    ok: true,
    route: 'bootstrap',
    data: {
      provider: 'Tushare Pro',
      transport: 'official-rest-post',
      domains: publicCatalog(),
      routes: ROUTES,
      supply: supply.data ?? supply,
    },
    freshness_class: 'static',
    fetched_at: supply.fetched_at || supply.as_of || null,
    retrieved_at: nowIso(now),
    as_of: supply.as_of || null,
    is_complete: supply.is_complete === true,
    warnings: supply.warnings || [],
    cache_status: 'metadata',
  };
}

async function routeSearch(adapter, request, url, now) {
  assertAllowedQueryKeys(url, ['q', 'domain', 'limit']);
  const queryText = String(url.searchParams.get('q') || '').trim();
  if (!queryText || queryText.length > 100) {
    throw adapterError('INVALID_SEARCH', 'A search query of 1–100 characters is required', 400);
  }
  const domain = normalizeDomain(url.searchParams.get('domain') || 'Stocks');
  const limit = cleanLimit(url.searchParams.get('limit'), 20, 50);
  if (domain === 'Supply') {
    const result = await callWarehouse(
      adapter.warehouse,
      'search',
      { query: queryText, limit, request },
      'disclosure',
    );
    const data = Array.isArray(result.data) ? result.data : [];
    const truncated = data.length > limit;
    return {
      ok: true,
      route: 'search',
      domain,
      data: Array.isArray(result.data) ? data.slice(0, limit) : result.data,
      row_count: Array.isArray(result.data) ? Math.min(data.length, limit) : null,
      source_endpoint: 'warehouse.search',
      freshness_class: warehouseFreshness(result, 'disclosure'),
      fetched_at: result.fetched_at || null,
      retrieved_at: result.retrieved_at || nowIso(now),
      as_of: result.as_of || null,
      is_complete: result.is_complete !== false && !truncated,
      warnings: truncated
        ? [...(result.warnings || []), 'route_limit_applied']
        : (result.warnings || []),
      cache_status: result.cache_status || 'warehouse',
    };
  }
  if (domain !== 'Stocks') {
    throw adapterError('SEARCH_DOMAIN_UNSUPPORTED', 'Search currently supports Stocks or Supply', 400);
  }
  const searchJobs = [
    ['stock_basic', {
      params: { list_status: 'L' },
      fields: 'ts_code,symbol,name,area,industry,market,exchange,list_date,cnspell',
      assetClass: 'a-stock',
    }],
    ['hk_basic', {
      params: { list_status: 'L' },
      fields: 'ts_code,name,fullname,enname,cn_spell,market,list_status,list_date,curr_type',
      assetClass: 'hk-stock',
    }],
    ['us_basic', {
      params: { offset: 0, limit: 6000 },
      fields: 'ts_code,name,enname,classify,list_date,delist_date',
      assetClass: 'us-stock',
    }],
  ];
  const settled = await Promise.allSettled(searchJobs.map(([apiName, job]) =>
    adapter.query(apiName, { params: job.params, fields: job.fields })));
  const successful = settled
    .map((result, index) => result.status === 'fulfilled'
      ? { apiName: searchJobs[index][0], job: searchJobs[index][1], result: result.value }
      : null)
    .filter(Boolean);
  if (!successful.length) {
    const firstFailure = settled.find((result) => result.status === 'rejected');
    throw firstFailure?.reason || adapterError(
      'TUSHARE_UPSTREAM_UNAVAILABLE',
      'Tushare search data is temporarily unavailable',
      502,
      'static',
    );
  }
  const sourceRows = successful.flatMap(({ apiName, job, result }) =>
    result.data.map((row) => ({
      ...row,
      asset_class: job.assetClass,
      source_endpoint: apiName,
    })));
  const needle = queryText.toLocaleLowerCase();
  const allMatches = sourceRows.filter((row) =>
    ['ts_code', 'symbol', 'name', 'enname', 'fullname', 'industry', 'market', 'cnspell', 'cn_spell']
      .some((key) => String(row[key] || '').toLocaleLowerCase().includes(needle)),
  );
  const matches = allMatches.slice(0, limit);
  return {
    ok: true,
    route: 'search',
    domain: 'Stocks',
    data: matches,
    row_count: matches.length,
    source_endpoint: successful.map((item) => item.apiName),
    source_doc_url: successful.map((item) => item.result.source_doc_url),
    fetched_at: successful.map((item) => item.result.fetched_at)
      .filter(Boolean).sort().at(-1) || null,
    retrieved_at: nowIso(now),
    as_of: successful.map((item) => item.result.as_of)
      .filter(Boolean).map(String).sort().at(-1) || null,
    freshness_class: 'static',
    entitlement_status: successful.length === searchJobs.length ? 'available' : 'partial',
    is_complete: successful.length === searchJobs.length &&
      successful.every((item) => item.result.is_complete) &&
      allMatches.length <= limit,
    warnings: [
      ...settled.flatMap((result, index) =>
        result.status === 'rejected' ? [`search_source_unavailable:${searchJobs[index][0]}`] : []),
      ...(allMatches.length > limit ? ['route_limit_applied'] : []),
    ],
    cache_status: Object.fromEntries(successful.map((item) => [
      item.apiName,
      item.result.cache_status,
    ])),
  };
}

async function routeMarket(adapter, request, url, now) {
  const domain = normalizeDomain(url.searchParams.get('domain') || 'Market');
  if (domain === 'Supply') {
    assertAllowedQueryKeys(url, ['domain', 'entity', 'year', 'limit']);
    const result = await callWarehouse(
      adapter.warehouse,
      'market',
      {
        domain,
        entity: url.searchParams.get('entity'),
        year: url.searchParams.get('year'),
        limit: cleanLimit(url.searchParams.get('limit'), 100, 1000),
        request,
      },
      'disclosure',
    );
    return {
      ok: true,
      route: 'market',
      domain,
      data: result.data,
      row_count: Array.isArray(result.data) ? result.data.length : null,
      source_endpoint: 'warehouse.market',
      freshness_class: warehouseFreshness(result, 'disclosure'),
      fetched_at: result.fetched_at || null,
      retrieved_at: result.retrieved_at || nowIso(now),
      as_of: result.as_of || null,
      is_complete: result.is_complete !== false,
      warnings: result.warnings || [],
      cache_status: result.cache_status || 'warehouse',
    };
  }

  const apiName = String(
    url.searchParams.get('dataset') || DEFAULT_MARKET_ENDPOINT[domain] || '',
  ).trim();
  const config = TUSHARE_ENDPOINTS[apiName];
  if (!config || config.domain !== domain || config.domain === 'News' ||
      WAREHOUSE_ONLY_DATASETS.has(apiName)) {
    throw adapterError('ENDPOINT_NOT_ALLOWED', 'Dataset is not allowed for this domain', 400);
  }
  assertAllowedQueryKeys(url, [
    'domain', 'dataset', 'limit', 'start', 'end',
    ...config.params,
  ], config.freshness_class);
  const params = routeParams(url, apiName, { start: 'start_date', end: 'end_date' });
  if (params.start_date) params.start_date = cleanDate(params.start_date, 'start');
  if (params.end_date) params.end_date = cleanDate(params.end_date, 'end');
  if (apiName === 'index_daily' && !params.ts_code && !params.trade_date) {
    Object.assign(params, {
      ts_code: '000300.SH',
      ...recentDateRange(now, 30),
    });
  }
  if (apiName === 'shibor' && !params.date && !params.start_date) {
    Object.assign(params, recentDateRange(now, 30));
  }
  const result = ensureRows(await adapter.query(apiName, {
    params,
    fields: '',
  }), config.freshness_class);
  const limit = cleanLimit(url.searchParams.get('limit'), 200, 1000);
  return limitedEnvelope({ ...result, route: 'market' }, limit);
}

async function routeNews(adapter, url, now) {
  const apiName = String(url.searchParams.get('dataset') || 'news').trim();
  const config = TUSHARE_ENDPOINTS[apiName];
  if (!config || config.domain !== 'News') {
    throw adapterError(
      'ENDPOINT_NOT_ALLOWED',
      'News dataset is not allowed',
      400,
      'news_incremental',
    );
  }
  assertAllowedQueryKeys(url, [
    'dataset', 'src', 'start', 'end', 'start_date', 'end_date',
    'ts_code', 'ann_date', 'limit',
  ], config.freshness_class);
  const params = {};
  if (apiName === 'news' || apiName === 'major_news') {
    const end = url.searchParams.get('end') || url.searchParams.get('end_date') ||
      chinaDateTime(new Date(now()));
    const start = url.searchParams.get('start') || url.searchParams.get('start_date') ||
      chinaDateTime(new Date(now() - 6 * HOUR * 1000));
    params.start_date = cleanDateTime(start, 'start');
    params.end_date = cleanDateTime(end, 'end');
    params.src = String(
      url.searchParams.get('src') || (apiName === 'major_news' ? '新浪财经' : 'sina'),
    ).trim();
    if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(params.src)) {
      throw adapterError(
        'INVALID_NEWS_SOURCE',
        'Unsupported news source format',
        400,
        config.freshness_class,
      );
    }
  } else {
    ['ts_code', 'ann_date', 'start_date', 'end_date'].forEach((key) => {
      const alias = key === 'start_date' ? 'start' : key === 'end_date' ? 'end' : key;
      const value = url.searchParams.get(key) || url.searchParams.get(alias);
      if (value) params[key] = key.includes('date') ? cleanDate(value, key) : value;
    });
  }
  const fields = apiName === 'major_news' ? 'title,pub_time,src' : '';
  const result = await adapter.query(apiName, { params, fields });
  const limit = cleanLimit(url.searchParams.get('limit'), 100, 500);
  return limitedEnvelope({ ...result, route: 'news' }, limit);
}

async function routeQuote(adapter, url, now) {
  assertAllowedQueryKeys(url, ['symbol', 'asset', 'dataset']);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  const mapped = normalizeAsset(url.searchParams.get('asset') || 'stock');
  const apiName = String(url.searchParams.get('dataset') || mapped.apiName).trim();
  if (apiName !== mapped.apiName || !TUSHARE_ENDPOINTS[apiName]) {
    throw adapterError('ENDPOINT_NOT_ALLOWED', 'Quote dataset is not allowed', 400);
  }
  const config = TUSHARE_ENDPOINTS[apiName];
  const range = recentDateRange(now, 14);
  const result = ensureRows(await adapter.query(apiName, {
    params: { ts_code: symbol, ...range },
    fields: '',
  }), config.freshness_class);
  const latest = [...result.data].sort((left, right) =>
    rowDateValue(right).localeCompare(rowDateValue(left)))[0];
  return {
    ...result,
    route: 'quote',
    data: latest,
    row_count: 1,
  };
}

async function routeHistory(adapter, url, now) {
  assertAllowedQueryKeys(url, [
    'symbol', 'asset', 'dataset', 'start', 'end', 'start_date', 'end_date',
    'limit',
  ]);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  const mapped = normalizeAsset(url.searchParams.get('asset') || 'stock');
  const apiName = String(url.searchParams.get('dataset') || mapped.apiName).trim();
  if (apiName !== mapped.apiName || !TUSHARE_ENDPOINTS[apiName]) {
    throw adapterError('ENDPOINT_NOT_ALLOWED', 'History dataset is not allowed', 400);
  }
  const config = TUSHARE_ENDPOINTS[apiName];
  const range = dateRangeFromUrl(url, now, true);
  const result = ensureRows(await adapter.query(apiName, {
    params: { ts_code: symbol, ...range },
    fields: '',
  }), config.freshness_class);
  const limit = cleanLimit(url.searchParams.get('limit'), 1000, 6000);
  const rows = [...result.data]
    .sort((left, right) => rowDateValue(left).localeCompare(rowDateValue(right)))
    .slice(-limit);
  const truncated = result.data.length > limit;
  return {
    ...result,
    route: 'history',
    data: rows,
    row_count: rows.length,
    is_complete: result.is_complete === true && !truncated,
    warnings: truncated
      ? [...result.warnings, 'route_limit_applied']
      : result.warnings,
  };
}

function stockDetailDatasets(symbol) {
  if (symbol.endsWith('.HK')) {
    return {
      profile: 'hk_basic',
      profileFields: 'ts_code,name,fullname,enname,market,list_status,list_date,curr_type',
      market: 'hk_daily',
      marketFields: 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount',
    };
  }
  if (!symbol.includes('.')) {
    return {
      profile: 'us_basic',
      profileFields: 'ts_code,name,enname,classify,list_date,delist_date',
      market: 'us_daily',
      marketFields: 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_change,vol,amount,vwap,total_mv,pe,pb',
    };
  }
  return {
    profile: 'stock_basic',
    profileFields: 'ts_code,symbol,name,area,industry,market,exchange,curr_type,list_date',
    market: 'daily_basic',
    marketFields: 'ts_code,trade_date,close,turnover_rate,pe_ttm,pb,total_mv,circ_mv',
  };
}

async function routeStockDetail(adapter, request, url, now) {
  assertAllowedQueryKeys(url, ['symbol', 'start', 'end']);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  const defaultRange = recentDateRange(now, 5 * 366);
  const range = url.searchParams.has('start') || url.searchParams.has('end')
    ? dateRangeFromUrl(url, now, true)
    : defaultRange;
  // Establish the required Supply authority before spending any Tushare quota.
  // A missing warehouse therefore fails closed without starting partial upstream work.
  const supply = await callWarehouse(
    adapter.warehouse,
    'stockDetail',
    { symbol, start_date: range.start_date, end_date: range.end_date, request },
    'disclosure',
  );
  warehouseFreshness(supply, 'disclosure');
  const datasets = stockDetailDatasets(symbol);
  const [profile, market] = await Promise.all([
    adapter.query(datasets.profile, {
      params: { ts_code: symbol },
      fields: datasets.profileFields,
    }),
    adapter.query(datasets.market, {
      params: { ts_code: symbol, ...recentDateRange(now, 30) },
      fields: datasets.marketFields,
    }),
  ]);
  ensureRows(profile, 'static');
  ensureRows(market, 'eod');
  const latestMarket = [...market.data].sort((left, right) =>
    rowDateValue(right).localeCompare(rowDateValue(left)))[0];
  const warehouseData = supply.data ?? supply;
  return {
    ok: true,
    route: 'stock-detail',
    domain: 'Stocks',
    data: {
      profile: profile.data[0],
      market: latestMarket,
      financials: warehouseData?.financials ?? null,
      supply: warehouseData,
    },
    row_count: 2,
    source_endpoint: [
      datasets.profile, datasets.market, 'warehouse.stockDetail',
    ],
    source_doc_url: [
      profile.source_doc_url,
      market.source_doc_url,
    ],
    fetched_at: [profile.fetched_at, market.fetched_at, supply.fetched_at]
      .filter(Boolean).sort().at(-1) || null,
    retrieved_at: [profile.retrieved_at, market.retrieved_at, supply.retrieved_at]
      .filter(Boolean).sort().at(-1) || nowIso(now),
    as_of: [profile.as_of, market.as_of, supply.as_of]
      .filter(Boolean).map(String).sort().at(-1) || null,
    freshness_class: 'disclosure',
    entitlement_status: 'available',
    is_complete: profile.is_complete && market.is_complete &&
      supply.is_complete !== false,
    warnings: [
      ...profile.warnings,
      ...market.warnings,
      ...(supply.warnings || []),
    ],
    cache_status: {
      profile: profile.cache_status,
      market: market.cache_status,
      supply: supply.cache_status || 'warehouse',
    },
  };
}

async function routeStatus(adapter, request, now) {
  let warehouseStatus = null;
  if (adapter.warehouseConfigured) {
    try {
      warehouseStatus = await callWarehouse(adapter.warehouse, 'status', { request }, 'static');
    } catch (_) {
      warehouseStatus = null;
    }
  }
  const ready = adapter.tokenConfigured && Boolean(warehouseStatus);
  const complete = ready && warehouseStatus?.is_complete === true;
  return {
    ok: ready,
    route: 'status',
    data: {
      ready,
      provider: 'Tushare Pro',
      transport: 'official-rest-post',
      token_configured: adapter.tokenConfigured,
      cache_configured: adapter.cacheConfigured,
      warehouse_configured: adapter.warehouseConfigured,
      warehouse_ready: Boolean(warehouseStatus),
      warehouse_complete: warehouseStatus?.is_complete === true,
      endpoint_count: Object.keys(TUSHARE_ENDPOINTS).length,
      domains: TERMINAL_DOMAINS,
    },
    freshness_class: 'static',
    fetched_at: null,
    retrieved_at: nowIso(now),
    as_of: warehouseStatus?.as_of || null,
    is_complete: complete,
    warnings: ready
      ? (warehouseStatus?.warnings || [])
      : ['adapter_not_ready'],
    cache_status: 'metadata',
    http_status: ready ? 200 : 503,
  };
}

function responseHeaders(env, cacheControl = 'no-store') {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': cacheControl,
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
}

function jsonResponse(env, body, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(env, cacheControl),
  });
}

async function enforceTerminalRateLimit(request, env, now) {
  const kv = env?.YC_KV;
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!clientIp || !kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return;
  }
  const configured = Number(env?.TERMINAL_RATE_LIMIT_PER_MINUTE || 120);
  const maximum = Number.isFinite(configured)
    ? Math.min(1000, Math.max(20, Math.floor(configured)))
    : 120;
  const bucket = Math.floor(now() / 60000);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${bucket}:${clientIp}`),
  );
  const identity = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const key = `terminal:rate:${bucket}:${identity}`;
  let count;
  try {
    count = Number(await kv.get(key)) || 0;
  } catch (_) {
    throw adapterError(
      'RATE_LIMIT_UNAVAILABLE',
      'Terminal request control is temporarily unavailable',
      503,
    );
  }
  if (count >= maximum) {
    throw adapterError(
      'TERMINAL_RATE_LIMITED',
      'Terminal request limit reached; retry after the next minute',
      429,
    );
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: 120 });
  } catch (_) {
    throw adapterError(
      'RATE_LIMIT_UNAVAILABLE',
      'Terminal request control is temporarily unavailable',
      503,
    );
  }
}

/**
 * Terminal route integration point.
 *
 * Returns null for non-Terminal routes so worker/worker.js can continue its
 * existing router. All supported Terminal routes are GET-only.
 */
export async function handleTushareTerminalRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!ROUTE_SET.has(path)) return null;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders(env) });
  }
  if (request.method !== 'GET') {
    return jsonResponse(env, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' },
      freshness_class: 'static',
    }, 405);
  }

  const now = typeof options.now === 'function' ? options.now : Date.now;
  let freshnessClass = 'static';
  try {
    assertNoSensitiveQuery(url);
    await enforceTerminalRateLimit(request, env, now);
    const adapter = createTushareAdapter(env, { ...options, now });
    let result;
    if (path === '/api/terminal/bootstrap') {
      assertAllowedQueryKeys(url, []);
      result = await routeBootstrap(adapter, request, now);
    } else if (path === '/api/terminal/search') {
      result = await routeSearch(adapter, request, url, now);
    } else if (path === '/api/terminal/market') {
      const candidate = url.searchParams.get('dataset');
      freshnessClass = freshnessForEndpoint(candidate);
      result = await routeMarket(adapter, request, url, now);
    } else if (path === '/api/terminal/news') {
      freshnessClass = freshnessForEndpoint(url.searchParams.get('dataset') || 'news');
      result = await routeNews(adapter, url, now);
    } else if (path === '/api/terminal/quote') {
      freshnessClass = freshnessForEndpoint(
        QUOTE_ENDPOINTS[String(url.searchParams.get('asset') || 'stock').toLowerCase()],
      );
      result = await routeQuote(adapter, url, now);
    } else if (path === '/api/terminal/history') {
      freshnessClass = freshnessForEndpoint(
        QUOTE_ENDPOINTS[String(url.searchParams.get('asset') || 'stock').toLowerCase()],
      );
      result = await routeHistory(adapter, url, now);
    } else if (path === '/api/terminal/stock-detail') {
      freshnessClass = 'disclosure';
      result = await routeStockDetail(adapter, request, url, now);
    } else {
      result = await routeStatus(adapter, request, now);
    }
    const status = Number(result.http_status) || 200;
    if ('http_status' in result) delete result.http_status;
    return jsonResponse(env, result, status);
  } catch (caught) {
    const error = publicError(caught, freshnessClass);
    return jsonResponse(env, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
      freshness_class: error.freshness_class,
    }, error.status);
  }
}

/**
 * Scheduled cache warm-up for the Terminal's default Market News screen.
 *
 * Each dataset is isolated so one entitlement failure cannot erase or block
 * other valid snapshots. The returned receipt contains dataset/error codes
 * only and never includes upstream bodies or credentials.
 */
export async function refreshTushareTerminalSnapshots(env, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const adapter = createTushareAdapter(env, { ...options, now });
  const range = recentDateRange(now, 30);
  const newsEnd = chinaDateTime(new Date(now()));
  const newsStart = chinaDateTime(new Date(now() - 12 * HOUR * 1000));
  const jobs = [
    ['index_daily', {
      params: { ts_code: '000300.SH', ...range },
      fields: 'ts_code,trade_date,open,high,low,close,pct_chg,vol,amount',
    }],
    ['index_global', {
      params: range,
      fields: 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg',
    }],
    ['shibor', {
      params: range,
      fields: 'date,on,1w,2w,1m,3m,6m,9m,1y',
    }],
    ['news', {
      params: {
        src: 'sina',
        start_date: newsStart,
        end_date: newsEnd,
      },
      fields: '',
    }],
  ];
  const settled = await Promise.allSettled(
    jobs.map(([dataset, request]) => adapter.query(dataset, request)),
  );
  const datasets = settled.map((result, index) => {
    const dataset = jobs[index][0];
    if (result.status === 'fulfilled') {
      return {
        dataset,
        ok: true,
        as_of: result.value.as_of,
        row_count: result.value.row_count,
        freshness_class: result.value.freshness_class,
        cache_status: result.value.cache_status,
      };
    }
    const error = publicError(result.reason, freshnessForEndpoint(dataset));
    return {
      dataset,
      ok: false,
      error_code: error.code,
      freshness_class: error.freshness_class,
    };
  });
  return {
    ok: datasets.some((item) => item.ok),
    refreshed_at: nowIso(now),
    datasets,
  };
}
