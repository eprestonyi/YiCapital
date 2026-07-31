import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTushareAdapter,
  FRESHNESS_CLASSES,
  handleTushareTerminalRequest,
  TERMINAL_DOMAINS,
  TUSHARE_API_URL,
  TUSHARE_ENDPOINTS,
} from '../worker/tushare.js';

const TOKEN = 'server-secret-token-that-must-never-leak';
const FIXED_NOW = Date.parse('2026-07-30T08:00:00.000Z');
const fixedNow = () => FIXED_NOW;

class MockKV {
  constructor() {
    this.values = new Map();
    this.gets = [];
    this.puts = [];
  }

  async get(key, type) {
    this.gets.push({ key, type });
    const value = this.values.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
    this.values.set(key, value);
  }
}

function upstreamResponse(apiName, params = {}) {
  const fixtures = {
    stock_basic: {
      fields: [
        'ts_code', 'symbol', 'name', 'area', 'industry', 'market',
        'exchange', 'curr_type', 'list_date', 'cnspell',
      ],
      items: params.ts_code
        ? [[params.ts_code, params.ts_code.split('.')[0], '平安银行', '深圳', '银行', '主板', 'SZSE', 'CNY', '19910403', 'payh']]
        : [
            ['000001.SZ', '000001', '平安银行', '深圳', '银行', '主板', 'SZSE', 'CNY', '19910403', 'payh'],
            ['600519.SH', '600519', '贵州茅台', '贵州', '白酒', '主板', 'SSE', 'CNY', '20010827', 'gzmt'],
          ],
    },
    index_daily: {
      fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pct_chg'],
      items: [
        ['000300.SH', '20260729', 3980, 4020, 3970, 4010, 0.8],
        ['000300.SH', '20260730', 4010, 4050, 4000, 4040, 0.75],
      ],
    },
    daily: {
      fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pct_chg'],
      items: [
        [params.ts_code || '000001.SZ', '20260729', 10, 10.3, 9.9, 10.2, 2],
        [params.ts_code || '000001.SZ', '20260730', 10.2, 10.5, 10.1, 10.4, 1.96],
      ],
    },
    rt_hk_k: {
      fields: ['ts_code', 'trade_time', 'open', 'high', 'low', 'close', 'pct_chg'],
      items: [[params.ts_code || '00700.HK', '2026-07-30 15:59:00', 550, 558, 548, 556, 1.1]],
    },
    hk_daily: {
      fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pct_chg'],
      items: [
        [params.ts_code || '00700.HK', '20260729', 545, 552, 542, 550, 0.9],
        [params.ts_code || '00700.HK', '20260730', 550, 558, 548, 556, 1.1],
      ],
    },
    daily_basic: {
      fields: ['ts_code', 'trade_date', 'close', 'turnover_rate', 'pe_ttm', 'pb', 'total_mv', 'circ_mv'],
      items: [[params.ts_code || '000001.SZ', '20260730', 10.4, 0.8, 6.5, 0.7, 20000000, 18000000]],
    },
    fina_indicator: {
      fields: ['ts_code', 'ann_date', 'end_date', 'eps', 'roe', 'roa', 'grossprofit_margin', 'netprofit_margin'],
      items: [[params.ts_code || '000001.SZ', '20260420', '20251231', 1.2, 11, 0.9, 35, 18]],
    },
    news: {
      fields: ['datetime', 'content', 'title', 'channels'],
      items: [['2026-07-30 15:45:00', '市场快讯正文', '市场快讯', '宏观']],
    },
    major_news: {
      fields: ['title', 'pub_time', 'src'],
      items: [['长篇新闻', '2026-07-30 15:30:00', '新浪财经']],
    },
    cb_daily: {
      fields: ['ts_code', 'trade_date', 'close', 'pct_chg'],
      items: [[params.ts_code || '110030.SH', '20260730', 120.5, 0.2]],
    },
    fund_daily: {
      fields: ['ts_code', 'trade_date', 'close', 'pct_chg'],
      items: [[params.ts_code || '510300.SH', '20260730', 4.1, 0.4]],
    },
    fut_daily: {
      fields: ['ts_code', 'trade_date', 'close', 'settle', 'vol'],
      items: [[params.ts_code || 'CU2608.SHF', '20260730', 70000, 69900, 120000]],
    },
    opt_daily: {
      fields: ['ts_code', 'trade_date', 'close', 'settle', 'vol'],
      items: [[params.ts_code || '10000001.SH', '20260730', 0.12, 0.11, 5000]],
    },
    fx_daily: {
      fields: ['ts_code', 'trade_date', 'bid_open', 'bid_close', 'bid_high', 'bid_low'],
      items: [[params.ts_code || 'USDCNH.FXCM', '20260730', 7.2, 7.19, 7.21, 7.18]],
    },
    shibor: {
      fields: ['date', 'on', '1w', '1m', '1y'],
      items: [['20260730', 1.3, 1.4, 1.5, 1.8]],
    },
  };
  return fixtures[apiName] || {
    fields: ['ts_code', 'trade_date'],
    items: [[params.ts_code || 'TEST.SZ', '20260730']],
  };
}

function createFetchMock(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const result = handler
      ? await handler({ url, init, body, calls })
      : { code: 0, msg: null, data: upstreamResponse(body.api_name, body.params) };
    return {
      ok: true,
      status: 200,
      async json() {
        return result;
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createWarehouse() {
  const calls = [];
  return {
    calls,
    async bootstrap(payload) {
      calls.push({ method: 'bootstrap', payload });
      return {
        ok: true,
        data: { snapshot_id: 'warehouse-2026-07-30', supply_available: true },
        as_of: '2026-07-30',
        freshness_class: 'static',
        is_complete: true,
      };
    },
    async search(payload) {
      calls.push({ method: 'search', payload });
      return {
        ok: true,
        data: [{ id: 'tsmc', name: 'TSMC', type: 'supply-company' }],
        as_of: '2026-07-30',
        freshness_class: 'disclosure',
        is_complete: true,
      };
    },
    async market(payload) {
      calls.push({ method: 'market', payload });
      return {
        ok: true,
        data: [{ from: 'tsmc', to: 'nvda', relationship: 'supplier' }],
        as_of: '2025',
        freshness_class: 'disclosure',
        is_complete: true,
      };
    },
    async stockDetail(payload) {
      calls.push({ method: 'stockDetail', payload });
      return {
        ok: true,
        data: {
          suppliers: ['warehouse-company-id'],
          financials: {
            canonicalYear: 2025,
            income: [{ metric: 'revenue', value: 100, method: 'disclosed' }],
          },
        },
        as_of: '2025',
        freshness_class: 'disclosure',
        is_complete: true,
      };
    },
    async status(payload) {
      calls.push({ method: 'status', payload });
      return {
        ok: true,
        data: { ready: true },
        as_of: '2026-07-30',
        freshness_class: 'static',
        is_complete: true,
      };
    },
  };
}

async function json(response) {
  return response.json();
}

test('the endpoint whitelist covers every requested domain and never treats Supply as Tushare data', () => {
  assert.deepEqual(TERMINAL_DOMAINS, [
    'Market',
    'Stocks',
    'Debt',
    'Supply',
    'ETF',
    'Derivatives',
    'Money & Currency',
  ]);
  const endpointDomains = new Set(
    Object.values(TUSHARE_ENDPOINTS).map((item) => item.domain),
  );
  for (const domain of TERMINAL_DOMAINS.filter((item) => item !== 'Supply')) {
    assert.ok(endpointDomains.has(domain), `${domain} must have a whitelisted endpoint`);
  }
  assert.equal(endpointDomains.has('Supply'), false);
  assert.deepEqual(
    new Set(Object.values(TUSHARE_ENDPOINTS).map((item) => item.freshness_class)),
    new Set(FRESHNESS_CLASSES),
  );
});

test('query uses the official REST POST contract and reads the token only from env', async () => {
  const fetchImpl = createFetchMock();
  const adapter = createTushareAdapter(
    { TUSHARE_TOKEN: TOKEN },
    {
      fetchImpl,
      cache: new MockKV(),
      now: fixedNow,
      // This must never override env.TUSHARE_TOKEN.
      token: 'attacker-controlled-option',
    },
  );
  const result = await adapter.query('daily', {
    params: { ts_code: '000001.SZ', start_date: '20260701', end_date: '20260730' },
    fields: 'ts_code,trade_date,close',
  });

  assert.equal(result.ok, true);
  assert.equal(result.freshness_class, 'eod');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, TUSHARE_API_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, {
    api_name: 'daily',
    token: TOKEN,
    params: {
      ts_code: '000001.SZ',
      start_date: '20260701',
      end_date: '20260730',
    },
    fields: 'ts_code,trade_date,close',
  });
});

test('endpoint and parameter whitelists reject arbitrary upstream calls before fetch', async () => {
  const fetchImpl = createFetchMock();
  const adapter = createTushareAdapter(
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), now: fixedNow },
  );

  await assert.rejects(
    adapter.query('user_selected_endpoint', { params: {} }),
    (error) => error.code === 'ENDPOINT_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    adapter.query('daily', { params: { ts_code: '000001.SZ', token: 'browser-token' } }),
    (error) => error.code === 'PARAM_NOT_ALLOWED' && error.status === 400,
  );
  await assert.rejects(
    adapter.query('daily', { params: { ts_code: '000001.SZ', arbitrary: 'value' } }),
    (error) => error.code === 'PARAM_NOT_ALLOWED' && error.status === 400,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('KV cache is keyed without the token and preserves the freshness envelope', async () => {
  const cache = new MockKV();
  const fetchImpl = createFetchMock();
  const adapter = createTushareAdapter(
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache, now: fixedNow },
  );
  const request = {
    params: { ts_code: '000001.SZ', start_date: '20260701', end_date: '20260730' },
  };

  const first = await adapter.query('daily', request);
  const second = await adapter.query('daily', request);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(first.cache_status, 'miss');
  assert.equal(second.cache_status, 'hit');
  assert.equal(second.freshness_class, 'eod');
  assert.equal(second.fetched_at, first.fetched_at);
  assert.ok(cache.puts.length === 1);
  assert.equal(cache.puts[0].key.includes(TOKEN), false);
  assert.equal(cache.puts[0].value.includes(TOKEN), false);
  assert.ok(cache.puts[0].options.expirationTtl >= 60);
});

test('timeout aborts the upstream request and returns a typed failure', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const adapter = createTushareAdapter(
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), now: fixedNow, timeoutMs: 10 },
  );

  await assert.rejects(
    adapter.query('daily', { params: { ts_code: '000001.SZ' } }),
    (error) => error.code === 'TUSHARE_TIMEOUT' &&
      error.status === 504 &&
      error.freshness_class === 'eod',
  );
});

test('permission and credential failures never expose the token or upstream message', async (t) => {
  await t.test('permission', async () => {
    const fetchImpl = createFetchMock(() => ({
      code: 2002,
      msg: `没有权限 token=${TOKEN}`,
      data: null,
    }));
    const response = await handleTushareTerminalRequest(
      new Request('https://terminal.test/api/terminal/market?domain=Market&dataset=index_daily&ts_code=000300.SH'),
      { TUSHARE_TOKEN: TOKEN },
      { fetchImpl, cache: new MockKV(), now: fixedNow },
    );
    const body = await json(response);
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'TUSHARE_PERMISSION_DENIED');
    assert.equal(body.freshness_class, 'eod');
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('没有权限'), false);
  });

  await t.test('credential', async () => {
    const fetchImpl = createFetchMock(() => ({
      code: -2001,
      msg: `invalid token ${TOKEN}`,
      data: null,
    }));
    const response = await handleTushareTerminalRequest(
      new Request('https://terminal.test/api/terminal/quote?symbol=000001.SZ'),
      { TUSHARE_TOKEN: TOKEN },
      { fetchImpl, cache: new MockKV(), now: fixedNow },
    );
    const body = await json(response);
    const serialized = JSON.stringify(body);
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'TUSHARE_AUTH_FAILED');
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('invalid token'), false);
  });
});

test('missing env secret fails closed and request query parameters cannot provide a token', async () => {
  const fetchImpl = createFetchMock();
  const missing = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=000001.SZ'),
    {},
    { fetchImpl, cache: new MockKV(), now: fixedNow },
  );
  const missingBody = await json(missing);
  assert.equal(missing.status, 503);
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.error.code, 'TUSHARE_NOT_CONFIGURED');

  const injected = await handleTushareTerminalRequest(
    new Request(`https://terminal.test/api/terminal/quote?symbol=000001.SZ&token=${TOKEN}`),
    {},
    { fetchImpl, cache: new MockKV(), now: fixedNow },
  );
  const injectedBody = await json(injected);
  assert.equal(injected.status, 400);
  assert.equal(injectedBody.error.code, 'SENSITIVE_QUERY_REJECTED');
  assert.equal(JSON.stringify(injectedBody).includes(TOKEN), false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('public Terminal routes apply an expiring per-client request limit', async () => {
  const kv = new MockKV();
  const env = {
    TUSHARE_TOKEN: TOKEN,
    YC_KV: kv,
    TERMINAL_RATE_LIMIT_PER_MINUTE: '20',
  };
  const options = {
    fetchImpl: createFetchMock(),
    cache: kv,
    warehouse: createWarehouse(),
    now: fixedNow,
  };
  for (let index = 0; index < 20; index += 1) {
    const response = await handleTushareTerminalRequest(
      new Request('https://terminal.test/api/terminal/status', {
        headers: { 'CF-Connecting-IP': '203.0.113.8' },
      }),
      env,
      options,
    );
    assert.equal(response.status, 200);
  }
  const limited = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/status', {
      headers: { 'CF-Connecting-IP': '203.0.113.8' },
    }),
    env,
    options,
  );
  const body = await json(limited);
  assert.equal(limited.status, 429);
  assert.equal(body.error.code, 'TERMINAL_RATE_LIMITED');
});

test('Supply routes exclusively through the warehouse and fail closed without it', async () => {
  const fetchImpl = createFetchMock();
  const warehouse = createWarehouse();
  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/market?domain=Supply&entity=nvda&year=2025'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), warehouse, now: fixedNow },
  );
  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.domain, 'Supply');
  assert.equal(body.source_endpoint, 'warehouse.market');
  assert.equal(body.freshness_class, 'disclosure');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(warehouse.calls[0].method, 'market');

  const unavailable = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/market?domain=Supply&entity=nvda'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), now: fixedNow },
  );
  const unavailableBody = await json(unavailable);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableBody.error.code, 'WAREHOUSE_UNAVAILABLE');
  assert.equal(unavailableBody.data, undefined);
});

test('market route enforces the dataset whitelist across all six Tushare domains', async (t) => {
  const cases = [
    ['Market', 'index_daily', 'ts_code=000300.SH', 'eod'],
    ['Stocks', 'daily', 'ts_code=000001.SZ', 'eod'],
    ['Debt', 'cb_daily', 'ts_code=110030.SH', 'eod'],
    ['ETF', 'fund_daily', 'ts_code=510300.SH', 'eod'],
    ['Derivatives', 'fut_daily', 'ts_code=CU2608.SHF', 'eod'],
    ['Money%20%26%20Currency', 'shibor', 'start=20260701&end=20260730', 'macro_release'],
  ];

  for (const [encodedDomain, dataset, params, freshnessClass] of cases) {
    await t.test(dataset, async () => {
      const fetchImpl = createFetchMock();
      const response = await handleTushareTerminalRequest(
        new Request(
          `https://terminal.test/api/terminal/market?domain=${encodedDomain}&dataset=${dataset}&${params}`,
        ),
        { TUSHARE_TOKEN: TOKEN },
        { fetchImpl, cache: new MockKV(), now: fixedNow },
      );
      const body = await json(response);
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.dataset, dataset);
      assert.equal(body.freshness_class, freshnessClass);
      assert.equal(fetchImpl.calls[0].body.api_name, dataset);
    });
  }

  const mismatchFetch = createFetchMock();
  const mismatch = await handleTushareTerminalRequest(
    new Request(
      'https://terminal.test/api/terminal/market?domain=Debt&dataset=daily&ts_code=000001.SZ',
    ),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl: mismatchFetch, cache: new MockKV(), now: fixedNow },
  );
  const mismatchBody = await json(mismatch);
  assert.equal(mismatch.status, 400);
  assert.equal(mismatchBody.error.code, 'ENDPOINT_NOT_ALLOWED');
  assert.equal(mismatchFetch.calls.length, 0);

  const filingFetch = createFetchMock();
  const filing = await handleTushareTerminalRequest(
    new Request(
      'https://terminal.test/api/terminal/market?domain=Stocks&dataset=income&ts_code=000001.SZ',
    ),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl: filingFetch, cache: new MockKV(), now: fixedNow },
  );
  const filingBody = await json(filing);
  assert.equal(filing.status, 400);
  assert.equal(filingBody.error.code, 'ENDPOINT_NOT_ALLOWED');
  assert.equal(filingFetch.calls.length, 0);

  const fieldsFetch = createFetchMock();
  const fields = await handleTushareTerminalRequest(
    new Request(
      'https://terminal.test/api/terminal/market?domain=Stocks&dataset=daily&fields=ts_code,close',
    ),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl: fieldsFetch, cache: new MockKV(), now: fixedNow },
  );
  const fieldsBody = await json(fields);
  assert.equal(fields.status, 400);
  assert.equal(fieldsBody.error.code, 'QUERY_PARAMETER_NOT_ALLOWED');
  assert.equal(fieldsFetch.calls.length, 0);
});

test('all eight Terminal route handlers return source-backed envelopes', async (t) => {
  const routes = [
    ['/api/terminal/bootstrap', 'bootstrap'],
    ['/api/terminal/search?q=%E5%B9%B3%E5%AE%89', 'search'],
    ['/api/terminal/market?domain=Market&dataset=index_daily&ts_code=000300.SH&start=20260701&end=20260730', 'market'],
    ['/api/terminal/news?src=sina&start=2026-07-30%2009%3A00%3A00&end=2026-07-30%2016%3A00%3A00', 'news'],
    ['/api/terminal/quote?symbol=000001.SZ', 'quote'],
    ['/api/terminal/history?symbol=000001.SZ&start=20260701&end=20260730', 'history'],
    ['/api/terminal/stock-detail?symbol=000001.SZ', 'stock-detail'],
    ['/api/terminal/status', 'status'],
  ];

  for (const [path, expectedRoute] of routes) {
    await t.test(expectedRoute, async () => {
      const fetchImpl = createFetchMock();
      const warehouse = createWarehouse();
      const response = await handleTushareTerminalRequest(
        new Request(`https://terminal.test${path}`),
        { TUSHARE_TOKEN: TOKEN, ALLOWED_ORIGIN: 'https://www.yicapital.co' },
        { fetchImpl, cache: new MockKV(), warehouse, now: fixedNow },
      );
      const body = await json(response);
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.route, expectedRoute);
      assert.ok(FRESHNESS_CLASSES.includes(body.freshness_class));
      assert.ok('data' in body);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://www.yicapital.co');
      assert.equal(JSON.stringify(body).includes(TOKEN), false);
    });
  }
});

test('stock search spans A-share, Hong Kong and US masters with explicit asset classes', async () => {
  const fetchImpl = createFetchMock(({ body }) => {
    if (body.api_name === 'hk_basic') {
      return {
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code', 'name', 'enname', 'market'],
          items: [['00700.HK', '腾讯控股', 'Tencent', '主板']],
        },
      };
    }
    if (body.api_name === 'us_basic') {
      return {
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code', 'name', 'enname', 'classify'],
          items: [['NVDA', '英伟达', 'NVIDIA', 'EQT']],
        },
      };
    }
    return {
      code: 0,
      msg: null,
      data: upstreamResponse(body.api_name, body.params),
    };
  });
  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/search?q=NVDA&domain=Stocks'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), warehouse: createWarehouse(), now: fixedNow },
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.data[0].ts_code, 'NVDA');
  assert.equal(body.data[0].asset_class, 'us-stock');
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.body.api_name).sort(),
    ['hk_basic', 'stock_basic', 'us_basic', 'us_basic'],
  );
  assert.ok(fetchImpl.calls.some((call) =>
    call.body.api_name === 'us_basic' && call.body.params.ts_code === 'NVDA'));
});

test('stock detail keeps financial statements in the warehouse plane', async () => {
  const fetchImpl = createFetchMock();
  const warehouse = createWarehouse();
  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/stock-detail?symbol=000001.SZ'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), warehouse, now: fixedNow },
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.data.financials.canonicalYear, 2025);
  assert.equal(body.data.financials.income[0].method, 'disclosed');
  assert.equal(
    fetchImpl.calls.some((call) => call.body.api_name === 'fina_indicator'),
    false,
  );
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.body.api_name).sort(),
    ['daily_basic', 'stock_basic'],
  );
});

test('history ordering, quote selection and news freshness are deterministic', async () => {
  const fetchImpl = createFetchMock();
  const cache = new MockKV();
  const options = { fetchImpl, cache, warehouse: createWarehouse(), now: fixedNow };
  const env = { TUSHARE_TOKEN: TOKEN };

  const history = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/history?symbol=000001.SZ&start=20260701&end=20260730'),
    env,
    options,
  ));
  assert.deepEqual(history.data.map((row) => row.trade_date), ['20260729', '20260730']);
  assert.equal(history.freshness_class, 'eod');

  const quote = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=000001.SZ'),
    env,
    options,
  ));
  assert.equal(quote.data.trade_date, '20260730');
  assert.equal(quote.row_count, 1);
  assert.equal(quote.quote_mode, 'realtime');
  assert.equal(quote.freshness_class, 'intraday_snapshot');
  assert.ok(fetchImpl.calls.some((call) => call.body.api_name === 'rt_k'));

  const news = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/news?src=sina&start=2026-07-30%2009%3A00%3A00&end=2026-07-30%2016%3A00%3A00'),
    env,
    options,
  ));
  assert.equal(news.freshness_class, 'news_incremental');
  assert.equal(news.as_of, '2026-07-30 15:45:00');

  const majorFetch = createFetchMock();
  const major = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/news?dataset=major_news'),
    env,
    { fetchImpl: majorFetch, cache: new MockKV(), warehouse: createWarehouse(), now: fixedNow },
  ));
  assert.equal(major.ok, true);
  assert.equal(majorFetch.calls[0].body.params.src, '新浪财经');
});

test('A-share quote falls back from Tushare realtime to the latest Tushare EOD snapshot', async () => {
  const fetchImpl = createFetchMock(({ body }) => {
    if (body.api_name === 'rt_k') {
      return { code: 2002, msg: 'permission unavailable', data: null };
    }
    return { code: 0, msg: null, data: upstreamResponse(body.api_name, body.params) };
  });
  const body = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=000001.SZ'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), warehouse: createWarehouse(), now: fixedNow },
  ));
  assert.equal(body.ok, true);
  assert.equal(body.quote_mode, 'eod_fallback');
  assert.equal(body.fallback, 'latest_eod_snapshot');
  assert.equal(body.freshness_class, 'eod');
  assert.match(body.warnings.join(' '), /TUSHARE_PERMISSION_DENIED/);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.body.api_name),
    ['rt_k', 'daily'],
  );
});

test('HK quote uses Tushare realtime and deterministically falls back to hk_daily', async () => {
  const liveFetch = createFetchMock();
  const live = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=00700.HK&asset=hk-stock'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl: liveFetch, cache: new MockKV(), warehouse: createWarehouse(), now: fixedNow },
  ));
  assert.equal(live.ok, true);
  assert.equal(live.quote_mode, 'realtime');
  assert.equal(live.data.close, 556);
  assert.deepEqual(liveFetch.calls.map((call) => call.body.api_name), ['rt_hk_k']);

  const fallbackFetch = createFetchMock(({ body }) => {
    if (body.api_name === 'rt_hk_k') {
      return { code: 2002, msg: 'permission unavailable', data: null };
    }
    return { code: 0, msg: null, data: upstreamResponse(body.api_name, body.params) };
  });
  const fallback = await json(await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=00700.HK&asset=hk-stock'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl: fallbackFetch, cache: new MockKV(), warehouse: createWarehouse(), now: fixedNow },
  ));
  assert.equal(fallback.ok, true);
  assert.equal(fallback.quote_mode, 'eod_fallback');
  assert.equal(fallback.fallback, 'latest_eod_snapshot');
  assert.equal(fallback.data.trade_date, '20260730');
  assert.match(fallback.warnings.join(' '), /TUSHARE_PERMISSION_DENIED/);
  assert.deepEqual(
    fallbackFetch.calls.map((call) => call.body.api_name),
    ['rt_hk_k', 'hk_daily'],
  );
});

test('empty upstream data is never replaced with synthetic quote/history data', async () => {
  const fetchImpl = createFetchMock(() => ({
    code: 0,
    msg: null,
    data: { fields: ['ts_code', 'trade_date', 'close'], items: [] },
  }));
  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/quote?symbol=000001.SZ'),
    { TUSHARE_TOKEN: TOKEN },
    { fetchImpl, cache: new MockKV(), now: fixedNow },
  );
  const body = await json(response);
  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NO_DATA');
  assert.equal(body.data, undefined);
  assert.equal(body.freshness_class, 'eod');
});

test('unknown paths return null and supported paths are GET-only', async () => {
  const unknown = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/other'),
    { TUSHARE_TOKEN: TOKEN },
  );
  assert.equal(unknown, null);

  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/status', { method: 'POST' }),
    { TUSHARE_TOKEN: TOKEN },
  );
  const body = await json(response);
  assert.equal(response.status, 405);
  assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
});
