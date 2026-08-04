import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  freezeLedgerPriceTape,
  handleLedgerAdminRequest,
  ledgerHealth,
  persistLedgerValuation,
} from '../worker/ledger-store.js';
import worker, {
  benchmarkSnapshotIsTushare,
  portfolioDataset,
  portfolioRealtimeDataset,
  prewarmBenchmark,
  rebuildPortfolioNavHistory,
  tusharePortfolioQuote,
  updatePortfolioNav,
  yahooUsCounterQuote,
  yahooUsPortfolioHistory,
} from '../worker/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_NOW = Date.parse('2026-07-30T08:00:00.000Z');
const now = () => FIXED_NOW;

class MockKV {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.puts = [];
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.puts.push({ key, value });
    this.values.set(key, value);
  }
}

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
  runInBatch() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Database {
  constructor(sql) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(sql);
  }
  prepare(sql) { return new D1Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runInBatch());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

async function ledgerDatabase() {
  const sql = await Promise.all([
    '0002_portfolio_ledger.sql',
    '0003_frozen_price_tapes.sql',
  ].map(file => readFile(path.join(ROOT, 'migrations', file), 'utf8')));
  return new D1Database(sql.join('\n'));
}

function adapterWith(handler) {
  const calls = [];
  return {
    calls,
    async query(dataset, request) {
      calls.push({ dataset, request });
      return handler(dataset, request);
    },
  };
}

function officialCalendar(request, openDates) {
  const compactToIso = value => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const start = compactToIso(request.params.start_date);
  const end = compactToIso(request.params.end_date);
  const opens = new Set(openDates.map(value => value.replaceAll('-', '')));
  const data = [];
  for (let time = Date.parse(`${start}T00:00:00.000Z`);
    time <= Date.parse(`${end}T00:00:00.000Z`);
    time += 86400000) {
    const calDate = new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
    data.push({ cal_date: calDate, is_open: opens.has(calDate) ? 1 : 0 });
  }
  return { data };
}

test('Tushare quote routing is A/HK realtime-first while its US source is EOD-only', async () => {
  assert.equal(portfolioDataset('a'), 'daily');
  assert.equal(portfolioDataset('hk'), 'hk_daily');
  assert.equal(portfolioDataset('us'), 'us_daily');
  assert.equal(portfolioRealtimeDataset('a'), 'rt_k');
  assert.equal(portfolioRealtimeDataset('hk'), 'rt_hk_k');
  assert.equal(portfolioRealtimeDataset('us'), null);

  const aAdapter = adapterWith(async dataset => {
    assert.equal(dataset, 'rt_k');
    return {
      data: [{ ts_code: '000001.SZ', close: 10.4, trade_time: '2026-07-30 15:00:00' }],
      freshness_class: 'intraday_snapshot',
      fetched_at: '2026-07-30T07:00:00.000Z',
    };
  });
  const aQuote = await tusharePortfolioQuote(aAdapter, '000001', 'a', now);
  assert.equal(aQuote.quote_mode, 'realtime');
  assert.equal(aQuote.date, '2026-07-30');
  assert.deepEqual(aAdapter.calls.map(call => call.dataset), ['rt_k']);

  const hkAdapter = adapterWith(async dataset => {
    assert.equal(dataset, 'rt_hk_k');
    return {
      data: [{ ts_code: '00700.HK', close: 556 }],
      freshness_class: 'intraday_snapshot',
      fetched_at: '2026-07-30T08:00:00.000Z',
    };
  });
  const hkQuote = await tusharePortfolioQuote(hkAdapter, '700.HK', 'hk', now, {
    verifiedSessionDate: '2026-07-30',
  });
  assert.equal(hkQuote.quote_mode, 'realtime');
  assert.equal(hkQuote.date, '2026-07-30');
  assert.equal(hkQuote.session_verified, true);
  assert.deepEqual(hkAdapter.calls.map(call => call.dataset), ['rt_hk_k']);

  const usAdapter = adapterWith(async dataset => {
    assert.equal(dataset, 'us_daily');
    return {
      data: [{ ts_code: 'NVDA', trade_date: '20260729', close: 180 }],
      freshness_class: 'eod',
      fetched_at: '2026-07-30T08:00:00.000Z',
    };
  });
  const usQuote = await tusharePortfolioQuote(usAdapter, 'NVDA', 'us', now);
  assert.equal(usQuote.quote_mode, 'eod');
  assert.equal(usQuote.freshness_class, 'eod');
  assert.deepEqual(usAdapter.calls.map(call => call.dataset), ['us_daily']);
});

test('Yahoo query2 US counter uses regularMarketPrice and regularMarketTime', async () => {
  const calls = [];
  const quote = await yahooUsCounterQuote(
    'BRK.B.US',
    () => Date.parse('2026-07-30T20:00:00.000Z'),
    {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        async json() {
          return { chart: { result: [{ meta: {
            regularMarketPrice: 512.34,
            regularMarketTime: Date.parse('2026-07-30T19:59:00.000Z') / 1000,
            marketState: 'REGULAR',
          } }] } };
        },
      };
    },
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /finance\/chart\/BRK-B/);
  assert.equal(quote.close, 512.34);
  assert.equal(quote.date, '2026-07-30');
  assert.equal(quote.source, 'yahoo:query2-chart');
  assert.equal(quote.price_basis, 'raw_counter');
  assert.equal(quote.adjusted, false);
  assert.equal(quote.regular_market_time, Date.parse('2026-07-30T19:59:00.000Z') / 1000);
});

test('Yahoo counter rejects an intraday print older than fifteen minutes', async () => {
  await assert.rejects(
    yahooUsCounterQuote('AAA.US', () => Date.parse('2026-07-30T19:30:01.000Z'), {
      fetch: async () => ({
        ok: true,
        async json() {
          return { chart: { result: [{ meta: {
            regularMarketPrice: 10,
            regularMarketTime: Date.parse('2026-07-30T19:15:00.000Z') / 1000,
            marketState: 'REGULAR',
          } }] } };
        },
      }),
    }),
    /yahoo_counter_payload_invalid/,
  );
});

test('Yahoo US history keeps raw Close and restores pre-split traded prices', async () => {
  const calls = [];
  const history = await yahooUsPortfolioHistory(
    'BRK.B.US',
    '2026-07-29',
    '2026-07-31',
    () => Date.parse('2026-08-01T00:00:00.000Z'),
    {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return {
          ok: true,
          async json() {
            return { chart: { error: null, result: [{
              timestamp: [
                Date.parse('2026-07-29T20:00:00.000Z') / 1000,
                Date.parse('2026-07-30T20:00:00.000Z') / 1000,
                Date.parse('2026-07-31T20:00:00.000Z') / 1000,
              ],
              meta: {
                regularMarketTime: Date.parse('2026-07-31T20:00:00.000Z') / 1000,
                regularMarketPrice: 35,
              },
              indicators: { quote: [{ close: [25, 30, null] }] },
              events: { splits: {
                split: {
                  date: Date.parse('2026-07-30T13:30:00.000Z') / 1000,
                  numerator: 4,
                  denominator: 1,
                  splitRatio: '4:1',
                },
              } },
            }] } };
          },
        };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /finance\/chart\/BRK-B/);
  assert.match(calls[0].url, /includeAdjustedClose=false/);
  assert.deepEqual(history.rows.map(row => ({
    date: row.date,
    close: row.close,
    source: row.source,
    priceBasis: row.valuation.priceBasis,
    adjusted: row.valuation.adjusted,
  })), [
    { date: '2026-07-29', close: 100, source: 'yahoo:query2-chart',
      priceBasis: 'raw_close', adjusted: false },
    { date: '2026-07-30', close: 30, source: 'yahoo:query2-chart',
      priceBasis: 'raw_close', adjusted: false },
    { date: '2026-07-31', close: 35, source: 'yahoo:query2-chart',
      priceBasis: 'raw_close', adjusted: false },
  ]);
});

test('dateless HK realtime never inherits a weekend wall-clock date', async () => {
  const weekendNow = () => Date.parse('2026-08-01T04:00:00.000Z'); // Saturday in HK.
  const adapter = adapterWith(async dataset => {
    if (dataset === 'rt_hk_k') {
      return {
        data: [{ ts_code: '00700.HK', close: 600 }],
        freshness_class: 'intraday_snapshot',
        fetched_at: '2026-08-01T04:00:00.000Z',
      };
    }
    assert.equal(dataset, 'hk_daily');
    return {
      data: [{ ts_code: '00700.HK', trade_date: '20260731', close: 556 }],
      freshness_class: 'eod',
      fetched_at: '2026-08-01T04:00:00.000Z',
    };
  });

  const quote = await tusharePortfolioQuote(adapter, '700.HK', 'hk', weekendNow, {
    verifiedSessionDate: '2026-07-31',
  });
  assert.equal(quote.quote_mode, 'eod_fallback');
  assert.equal(quote.date, '2026-07-31');
  assert.notEqual(quote.date, '2026-08-01');
  assert.deepEqual(adapter.calls.map(call => call.dataset), ['rt_hk_k', 'hk_daily']);
});

test('A/HK realtime failures fall back only to the matching Tushare EOD dataset', async () => {
  for (const spec of [
    { market: 'a', ticker: '000001', live: 'rt_k', eod: 'daily' },
    { market: 'hk', ticker: '700.HK', live: 'rt_hk_k', eod: 'hk_daily' },
  ]) {
    const adapter = adapterWith(async dataset => {
      if (dataset === spec.live) {
        const error = new Error('entitlement unavailable');
        error.code = 'TUSHARE_PERMISSION_DENIED';
        throw error;
      }
      assert.equal(dataset, spec.eod);
      return {
        data: [{ ts_code: spec.ticker, trade_date: '20260730', close: 100 }],
        freshness_class: 'eod',
        fetched_at: '2026-07-30T10:00:00.000Z',
      };
    });
    const quote = await tusharePortfolioQuote(adapter, spec.ticker, spec.market, now);
    assert.equal(quote.quote_mode, 'eod_fallback');
    assert.equal(quote.fallback, 'latest_eod_snapshot');
    assert.equal(quote.realtime_failure, 'TUSHARE_PERMISSION_DENIED');
    assert.deepEqual(adapter.calls.map(call => call.dataset), [spec.live, spec.eod]);
  }
});

test('legacy A-share .SS symbols are normalized to Tushare .SH', async () => {
  const adapter = adapterWith(async (dataset, request) => {
    assert.equal(dataset, 'rt_k');
    assert.equal(request.params.ts_code, '600000.SH');
    return {
      data: [{ ts_code: '600000.SH', close: 12.5, trade_time: '2026-07-30 15:00:00' }],
      freshness_class: 'intraday_snapshot',
    };
  });
  const quote = await tusharePortfolioQuote(adapter, '600000.SS', 'a', now);
  assert.equal(quote.close, 12.5);
});

test('benchmark refresh replaces legacy sources instead of relabeling them as Tushare', async () => {
  const legacy = JSON.stringify({
    ok: true,
    data: {
      'S&P 500': [{ date: '2000-01-03', close: 100 }],
      NASDAQ: [{ date: '2000-01-03', close: 100 }],
      DOW: [{ date: '2000-01-03', close: 100 }],
    },
    sources: { 'S&P 500': 'yahoo', NASDAQ: 'stooq', DOW: 'yahoo' },
  });
  const kv = new MockKV({ 'bmset:us': legacy });
  const adapter = adapterWith(async (dataset, request) => {
    assert.equal(dataset, 'index_global');
    assert.equal(request.params.start_date, '20100101');
    return {
      data: Array.from({ length: 25 }, (_, index) => ({
        trade_date: new Date(Date.UTC(2010, 0, 1 + index))
          .toISOString().slice(0, 10).replaceAll('-', ''),
        close: 1000 + index,
      })),
      freshness_class: 'eod',
      fetched_at: '2026-07-30T10:00:00.000Z',
    };
  });
  await prewarmBenchmark({ YC_KV: kv }, ['us'], { adapter, now });
  const snapshot = JSON.parse(kv.values.get('bmset:us'));
  assert.equal(benchmarkSnapshotIsTushare(snapshot, 'us'), true);
  assert.equal(JSON.stringify(snapshot).includes('2000-01-03'), false);
  assert.deepEqual(
    Object.values(snapshot.sources),
    ['tushare:index_global', 'tushare:index_global', 'tushare:index_global'],
  );
});

test('Hong Kong benchmarks use disclosed Tushare index_global series', async () => {
  const kv = new MockKV();
  const adapter = adapterWith(async (dataset, request) => {
    assert.equal(dataset, 'index_global');
    assert.equal(['HSI', 'HKTECH'].includes(request.params.ts_code), true);
    return {
      data: Array.from({ length: 25 }, (_, index) => ({
        trade_date: new Date(Date.UTC(2026, 0, 1 + index))
          .toISOString().slice(0, 10).replaceAll('-', ''),
        close: 20000 + index,
      })),
      freshness_class: 'eod',
      fetched_at: '2026-07-30T10:00:00.000Z',
    };
  });
  await prewarmBenchmark({ YC_KV: kv }, ['hk'], { adapter, now });
  const snapshot = JSON.parse(kv.values.get('bmset:hk'));
  assert.equal(benchmarkSnapshotIsTushare(snapshot, 'hk'), true);
  assert.deepEqual(Object.keys(snapshot.data).sort(), ['HSI', 'HSTECH']);
  assert.deepEqual(
    Object.values(snapshot.sources),
    ['tushare:index_global', 'tushare:index_global'],
  );
});

test('public benchmark route rejects a persisted non-Tushare legacy snapshot', async () => {
  const kv = new MockKV({
    'bmset:us': JSON.stringify({
      ok: true,
      data: { 'S&P 500': [{ date: '2026-07-30', close: 100 }] },
      sources: { 'S&P 500': 'yahoo' },
    }),
  });
  const response = await worker.fetch(
    new Request('https://portal.test/api/benchmark?set=us'),
    { YC_KV: kv, ALLOWED_ORIGIN: 'https://www.yicapital.co' },
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.data, {});
});

test('a failed portfolio refresh leaves the previous navcache byte-for-byte unchanged', async () => {
  const prior = '{"ok":true,"snapshot_id":"last-success","as_of":"2026-07-29"}';
  const kv = new MockKV({
    'ledger:hk': JSON.stringify({
      market: 'hk',
      positions: [{ t: '700.HK', n: 'Tencent', q: 10, mv: 5000, pnl: 0 }],
      cash: 0,
      liability: 0,
      units: 100,
      lastDate: '2026-07-29',
      lastUnitNav: 50,
      baseNetValue: 5000,
    }),
    'navcache:hk': prior,
  });
  const adapter = adapterWith(async () => {
    throw new Error('upstream unavailable');
  });
  const status = await updatePortfolioNav(
    { YC_KV: kv },
    'hk',
    { adapter, now },
  );
  assert.equal(status.fallback, true);
  assert.equal(status.reason, 'latest_tushare_request_failed');
  assert.equal(kv.values.get('navcache:hk'), prior);
  assert.deepEqual(
    kv.puts.map(write => write.key),
    ['navstatus:hk'],
  );
});

test('ordinary NAV refresh and public cache fail closed while derived ledger work is pending', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  database.database.prepare(`
    INSERT INTO ledger_outbox (
      outbox_id, portfolio_id, ledger_revision, kind, payload_json,
      status, attempts, available_at, created_at
    ) VALUES ('nav-1', 'us', 1, 'RECALC_NAV', '{"affectedFrom":"2026-07-20"}',
      'PENDING', 0, 0, 1)
  `).run();
  const kv = new MockKV({
    'ledger:us': JSON.stringify({
      market: 'us', portfolio: 'us', currency: 'USD', positions: [],
      cash: 1000, liability: 0, units: 1000, lastDate: '2026-07-29',
      lastUnitNav: 1, baseNetValue: 1000, ledgerRevision: 1,
      navRecalculationRequired: [],
    }),
    'navcache:us': JSON.stringify({
      ok: true, enabled: true, portfolio: 'us', ledgerRevision: 1,
      navRows: [{ date: '2026-07-29', nav: 1 }], history: [],
      cacheVersion: 3,
    }),
  });
  const adapter = adapterWith(async () => {
    throw new Error('ordinary price refresh must not run while outbox is pending');
  });
  const env = { YC_KV: kv, FEEDBACK_DB: database };

  const status = await updatePortfolioNav(env, 'us', { adapter, now });
  assert.equal(status.skip, 'ledger-derived-work-pending');
  assert.equal(status.fallback, true);
  assert.equal(status.pendingCount, 1);
  assert.equal(adapter.calls.length, 0);
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_nav_snapshots WHERE portfolio_id = 'us'
  `).get().count, 0);

  const response = await worker.fetch(new Request('https://portal.test/api/nav/us'), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).pending, true);
});

test('historical NAV replay fails closed when any ticker history request fails', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-21', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260720', '20260721', '20260730']);
    }
    if (request.params.ts_code === 'AAPL') return { data: [
      { ts_code: 'AAPL', trade_date: '20260720', close: 600 },
      { ts_code: 'AAPL', trade_date: '20260721', close: 601 },
      { ts_code: 'AAPL', trade_date: '20260730', close: 610 },
    ] };
    if (request.params.ts_code === 'AAA') throw new Error('temporary upstream failure');
    return { data: [] };
  });

  await assert.rejects(
    rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
      adapter, now, affectedFrom: '2026-07-20', ledgerRevision: 2,
    }),
    error => error && error.code === 'HISTORICAL_NAV_PRICE_HISTORY_UNAVAILABLE' &&
      /AAA/.test(error.message),
  );
});

test('historical NAV rejects a successful empty raw-close response instead of using book value', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-20', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') return officialCalendar(request, ['20260720']);
    if (request.params.ts_code === 'AAPL') {
      return { data: [{ ts_code: 'AAPL', trade_date: '20260720', close: 600 }] };
    }
    return { data: [] };
  });

  await assert.rejects(
    rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
      adapter, now: () => Date.parse('2026-07-20T22:00:00.000Z'),
      affectedFrom: '2026-07-20', ledgerRevision: 2,
    }),
    error => error && error.code === 'HISTORICAL_NAV_PRICE_HISTORY_UNAVAILABLE' &&
      /AAA/.test(error.message),
  );
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tapes WHERE portfolio_id = 'us'
  `).get().count, 0);
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_nav_snapshots WHERE portfolio_id = 'us'
  `).get().count, 0);
});

test('production-style US replay freezes Yahoo raw closes with a Tushare calendar', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-21', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260720', '20260721', '20260730']);
    }
    assert.equal(dataset, 'us_daily');
    assert.equal(request.params.ts_code, 'AAPL');
    return { data: [
      { ts_code: 'AAPL', trade_date: '20260720', close: 600 },
      { ts_code: 'AAPL', trade_date: '20260721', close: 601 },
      { ts_code: 'AAPL', trade_date: '20260730', close: 610 },
    ] };
  });
  const historyCalls = [];
  const historyFetch = async url => {
    historyCalls.push(String(url));
    return {
      ok: true,
      async json() {
        return { chart: { error: null, result: [{
          timestamp: [
            Date.parse('2026-07-21T20:00:00.000Z') / 1000,
            Date.parse('2026-07-30T20:00:00.000Z') / 1000,
          ],
          indicators: { quote: [{ close: [10, 12] }] },
        }] } };
      },
    };
  };

  const replay = await rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
    adapter,
    historyFetch,
    now,
    affectedFrom: '2026-07-20',
    ledgerRevision: 2,
  });
  assert.equal(replay.complete, false);
  assert.equal(historyCalls.length, 1);
  assert.match(historyCalls[0], /finance\/chart\/AAA/);
  assert.deepEqual({ ...database.database.prepare(`
    SELECT price_source, price_basis, adjusted, price_row_count
    FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 2
  `).get() }, {
    price_source: 'us-raw-close:yahoo+chartexchange',
    price_basis: 'raw_close',
    adjusted: 0,
    price_row_count: 2,
  });
});

test('inactive XHYH prefix comes from source-backed raw closes instead of book value', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-01-05',
        shareholder: 'LP1', subscription: '30000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-01-06', ticker: 'XHYH',
        quantity: 600, gross_amount: '21456', net_cash: '-21456' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260105', '20260106']);
    }
    assert.equal(dataset, 'us_daily');
    assert.equal(request.params.ts_code, 'AAPL');
    return { data: [
      { ts_code: 'AAPL', trade_date: '20260105', close: 300 },
      { ts_code: 'AAPL', trade_date: '20260106', close: 301 },
    ] };
  });
  const historyCalls = [];
  const historyFetch = async url => {
    const value = String(url);
    historyCalls.push(value);
    if (value.includes('chartexchange.com')) {
      return {
        ok: true,
        async text() {
          return `
            <table>
              <tr><td><a name="2026-01-06"></a><a href="#2026-01-06">2026-01-06</a></td>
                <td>35.752200</td><td>35.803200</td><td>35.7522</td><td>35.8032</td></tr>
              <tr><td><a name="2026-01-05"></a><a href="#2026-01-05">2026-01-05</a></td>
                <td>35.950000</td><td>35.950000</td><td>35.7200</td><td>35.9272</td></tr>
            </table>`;
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { chart: { error: null, result: [{
          timestamp: [Date.parse('2026-05-15T20:00:00.000Z') / 1000],
          indicators: { quote: [{ close: [35.27] }] },
        }] } };
      },
    };
  };

  await rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
    adapter,
    historyFetch,
    now: () => Date.parse('2026-01-06T22:00:00.000Z'),
    affectedFrom: '2026-01-05',
    ledgerRevision: 2,
  });
  assert.equal(historyCalls.length, 2);
  assert.ok(historyCalls.some(url => url.includes('finance.yahoo.com')));
  assert.ok(historyCalls.some(url => url.includes('chartexchange.com/symbol/nyse-xhyh')));
  const rows = database.database.prepare(`
    SELECT ticker, price_date, price_micros, source, source_ref
    FROM ledger_price_tape_rows WHERE price_tape_id = 'raw-close:us:2'
    ORDER BY price_date
  `).all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { ticker: 'XHYH', price_date: '2026-01-06', price_micros: 35803200,
      source: 'us-raw-close:yahoo+chartexchange',
      source_ref: 'https://chartexchange.com/symbol/nyse-xhyh/historical/:close:raw-unadjusted' },
  ]);
});

test('a dividend-only ticker that was never held does not require a price tape row', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'dividend-no-position', type: 'DIVIDEND', date: '2026-07-20',
        ticker: 'XHYH', quantity: 1, gross_amount: '5', net_cash: '5' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') return officialCalendar(request, ['20260720']);
    assert.equal(request.params.ts_code, 'AAPL');
    return { data: [{ ts_code: 'AAPL', trade_date: '20260720', close: 600 }] };
  });

  const replay = await rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
    adapter, now: () => Date.parse('2026-07-20T22:00:00.000Z'),
    affectedFrom: '2026-07-20', ledgerRevision: 2,
  });
  assert.equal(replay.complete, false);
  assert.equal(adapter.calls.length, 2);
  const tape = database.database.prepare(`
    SELECT required_tickers_json, price_row_count
    FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 2
  `).get();
  assert.deepEqual(JSON.parse(tape.required_tickers_json), []);
  assert.equal(tape.price_row_count, 0);
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tape_rows
  `).get().count, 0);
});

test('historical NAV rejects an empty market calendar and never fabricates business days', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 1, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
    ],
  };
  const adapter = adapterWith(async () => ({ data: [] }));

  await assert.rejects(
    rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
      adapter, now, affectedFrom: '2026-07-20', ledgerRevision: 1,
    }),
    error => error && error.code === 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE' &&
      error.message.includes('portfolio_calendar_tape_incomplete:2026-07-20'),
  );
  assert.equal(adapter.calls.length, 1);
  assert.doesNotMatch(await readFile(path.join(ROOT, 'worker/worker.js'), 'utf8'),
    /BUSINESS_DAY_CALENDAR_FALLBACK|function businessDates/);
});

test('official calendar proves a closed weekend but rejects an incomplete future extension', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 3 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 3, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-23',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-23', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      if (request.params.end_date === '20260727') return { data: [] };
      return officialCalendar(request, ['20260723', '20260724']);
    }
    if (request.params.ts_code === 'AAPL') return { data: [
      { ts_code: 'AAPL', trade_date: '20260723', close: 600 },
      { ts_code: 'AAPL', trade_date: '20260724', close: 601 },
    ] };
    return { data: [
      { ts_code: 'AAA', trade_date: '20260723', close: 10 },
      { ts_code: 'AAA', trade_date: '20260724', close: 11 },
    ] };
  });
  const env = { FEEDBACK_DB: database };
  const first = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-24T22:00:00.000Z'),
    affectedFrom: '2026-07-23', ledgerRevision: 3, batchSize: 50,
  });
  const weekend = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-26T22:00:00.000Z'),
    affectedFrom: '2026-07-23', ledgerRevision: 3, batchSize: 50,
  });
  assert.equal(weekend.targetThrough, first.targetThrough);
  assert.equal(weekend.targetThrough, '2026-07-24');
  await assert.rejects(
    rebuildPortfolioNavHistory(env, 'us', led, {
      adapter,
      now: () => Date.parse('2026-07-28T02:00:00.000Z'),
      affectedFrom: '2026-07-23', ledgerRevision: 3, batchSize: 50,
    }),
    error => error && error.code === 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE',
  );
  assert.equal(database.database.prepare(`
    SELECT tape_through FROM ledger_price_tapes
    WHERE portfolio_id = 'us' AND ledger_revision = 3
  `).get().tape_through, '2026-07-24');
});

test('intraday replay stops at the raw EOD watermark and still rejects older gaps', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 4 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 4, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-23',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-23', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  let eodAvailable = false;
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260723', '20260724']);
    }
    if (request.params.ts_code === 'AAPL') return { data: [
      { ts_code: 'AAPL', trade_date: '20260723', close: 600 },
      ...(eodAvailable ? [{ ts_code: 'AAPL', trade_date: '20260724', close: 601 }] : []),
    ] };
    return { data: [
      { ts_code: 'AAA', trade_date: '20260723', close: 10 },
      { ts_code: 'AAA', trade_date: '20260724', close: 12 },
    ].filter(row => row.trade_date >= request.params.start_date &&
      row.trade_date <= request.params.end_date) };
  });
  const env = { FEEDBACK_DB: database };
  const intraday = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-24T17:00:00.000Z'),
    affectedFrom: '2026-07-23', ledgerRevision: 4, batchSize: 50,
  });
  assert.equal(intraday.targetThrough, '2026-07-23');
  assert.deepEqual({ ...database.database.prepare(`
    SELECT tape_through, price_basis, adjusted FROM ledger_price_tapes
    WHERE portfolio_id = 'us' AND ledger_revision = 4
  `).get() }, {
    tape_through: '2026-07-23', price_basis: 'raw_close', adjusted: 0,
  });
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tape_rows
    WHERE price_date = '2026-07-24'
  `).get().count, 0);

  await assert.rejects(
    rebuildPortfolioNavHistory(env, 'us', led, {
      adapter,
      now: () => Date.parse('2026-07-25T17:00:00.000Z'),
      affectedFrom: '2026-07-23', ledgerRevision: 4, batchSize: 50,
    }),
    error => error && error.code === 'HISTORICAL_NAV_CALENDAR_UNAVAILABLE',
  );
  assert.equal(database.database.prepare(`
    SELECT tape_through FROM ledger_price_tapes
    WHERE portfolio_id = 'us' AND ledger_revision = 4
  `).get().tape_through, '2026-07-23');

  eodAvailable = true;
  const replay = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-25T17:00:00.000Z'),
    affectedFrom: '2026-07-23', ledgerRevision: 4, batchSize: 50,
  });
  assert.equal(replay.targetThrough, '2026-07-24');
  assert.equal(database.database.prepare(`
    SELECT tape_through FROM ledger_price_tapes
    WHERE portfolio_id = 'us' AND ledger_revision = 4
  `).get().tape_through, '2026-07-24');
});

test('historical NAV fails closed on an as-of tape gap and writes no book-value row', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 2, navRows: [],
    confirmedEvents: [
      { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20',
        shareholder: 'LP1', subscription: '1000', redemption: '0', unit_price: '1' },
      { event_id: 'buy-1', type: 'BUY', date: '2026-07-20', ticker: 'AAA',
        quantity: 10, gross_amount: '100', net_cash: '-100' },
    ],
  };
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260720', '20260721']);
    }
    if (request.params.ts_code === 'AAPL') return { data: [
      { ts_code: 'AAPL', trade_date: '20260720', close: 600 },
      { ts_code: 'AAPL', trade_date: '20260721', close: 601 },
    ] };
    return { data: [{ ts_code: 'AAA', trade_date: '20260721', close: 12 }] };
  });

  await assert.rejects(
    rebuildPortfolioNavHistory({ FEEDBACK_DB: database }, 'us', led, {
      adapter, now: () => Date.parse('2026-07-21T22:00:00.000Z'),
      affectedFrom: '2026-07-20', ledgerRevision: 2,
    }),
    error => error && error.code === 'HISTORICAL_NAV_PRICE_TAPE_GAP' &&
      /2026-07-20:AAA/.test(error.message),
  );
  assert.equal(database.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_nav_snapshots WHERE portfolio_id = 'us'
  `).get().count, 0);
});

test('a back-dated revision may prepend raw history but cannot revise the parent overlap', async () => {
  const database = await ledgerDatabase();
  const env = { FEEDBACK_DB: database };
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const common = {
    requiredTickers: ['AAA'],
    priceSource: 'tushare:us_daily',
    calendarSource: 'tushare:us_tradecal+us_daily',
    calendarSourceRef: 'us_tradecal:is_open+us_daily:AAPL:eod-watermark',
    priceBasis: 'raw_close',
    adjusted: false,
  };
  await freezeLedgerPriceTape(env, 'us', {
    ...common,
    tapeFrom: '2026-07-20', tapeThrough: '2026-07-21',
    calendarFrom: '2026-07-20', calendarDates: ['2026-07-20', '2026-07-21'],
    priceRows: [
      { ticker: 'AAA', date: '2026-07-20', close: 10,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
      { ticker: 'AAA', date: '2026-07-21', close: 11,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
    ],
  }, 1);
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const child = {
    ...common,
    tapeFrom: '2026-07-17', tapeThrough: '2026-07-22',
    calendarFrom: '2026-07-17',
    calendarDates: ['2026-07-17', '2026-07-20', '2026-07-21', '2026-07-22'],
    parentPriceTapeId: 'raw-close:us:1',
    inheritedThrough: '2026-07-21',
    priceRows: [
      { ticker: 'AAA', date: '2026-07-17', close: 9,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
      { ticker: 'AAA', date: '2026-07-20', close: 10,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
      { ticker: 'AAA', date: '2026-07-21', close: 11,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
      { ticker: 'AAA', date: '2026-07-22', close: 12,
        source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted' },
    ],
  };
  const revisedOverlap = {
    ...child,
    priceRows: child.priceRows.map(row => row.date === '2026-07-20'
      ? { ...row, close: 999 }
      : row),
  };
  await assert.rejects(
    freezeLedgerPriceTape(env, 'us', revisedOverlap, 2),
    error => error && error.details &&
      error.details.code === 'HISTORICAL_NAV_PRICE_TAPE_IMMUTABLE_CONFLICT',
  );
  const tape = await freezeLedgerPriceTape(env, 'us', child, 2);
  assert.equal(tape.parentPriceTapeId, 'raw-close:us:1');
  assert.deepEqual(tape.calendarDates, child.calendarDates);
  assert.deepEqual(tape.priceRows.map(row => [row.date, row.price]), [
    ['2026-07-17', 9], ['2026-07-20', 10], ['2026-07-21', 11], ['2026-07-22', 12],
  ]);
});

test('same-revision raw tape is deterministic, then only appends future EOD rows', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 5 WHERE portfolio_id = 'us'
  `).run();
  const events = [
    { event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20', sequence: 1,
      shareholder: 'LP1', subscription: '3000', redemption: '0', unit_price: '1' },
    { event_id: 'buy-aaa', type: 'BUY', date: '2026-07-20', sequence: 1,
      ticker: 'AAA', quantity: 10, gross_amount: '100', net_cash: '-100' },
    { event_id: 'buy-old', type: 'BUY', date: '2026-07-20', sequence: 2,
      ticker: 'OLD', quantity: 5, gross_amount: '50', net_cash: '-50' },
    { event_id: 'buy-susp', type: 'BUY', date: '2026-07-20', sequence: 3,
      ticker: 'SUSP', quantity: 10, gross_amount: '50', net_cash: '-50' },
    { event_id: 'sell-old', type: 'SELL', date: '2026-07-21', sequence: 1,
      ticker: 'OLD', quantity: 5, gross_amount: '50', net_cash: '50' },
  ];
  const led = {
    market: 'us', portfolio: 'us', ledgerRevision: 5,
    confirmedEvents: events, navRows: [],
  };
  let supplierRevisedOldHistory = false;
  const adapter = adapterWith(async (dataset, request) => {
    const extension = request.params.start_date === '20260722';
    const extensionTarget = request.params.end_date === '20260723';
    const nextRevision = request.params.end_date === '20260724';
    if (dataset === 'us_tradecal') {
      return officialCalendar(
        request,
        nextRevision ? ['20260724']
          : extension ? ['20260722', '20260723'] : ['20260720', '20260721'],
      );
    }
    if (request.params.ts_code === 'AAPL') {
      const tradeDates = nextRevision
        ? ['20260720', '20260721', '20260722', '20260723', '20260724']
        : extensionTarget ? ['20260720', '20260721', '20260722', '20260723']
          : ['20260720', '20260721'];
      return { data: tradeDates.map((trade_date, index) => ({
        ts_code: 'AAPL', trade_date, close: 600 + index,
      })) };
    }
    if (supplierRevisedOldHistory && request.params.start_date < '20260724') {
      return { data: [{
        ts_code: request.params.ts_code, trade_date: '20260721', close: 999,
      }] };
    }
    if (request.params.start_date === '20260724') {
      if (request.params.ts_code === 'AAA') {
        return { data: [{ ts_code: 'AAA', trade_date: '20260724', close: 14 }] };
      }
      if (request.params.ts_code === 'NEW') {
        return { data: [{ ts_code: 'NEW', trade_date: '20260724', close: 20 }] };
      }
      return { data: [] };
    }
    if (!extension) {
      const closes = request.params.ts_code === 'AAA' ? [10, 11]
        : request.params.ts_code === 'SUSP' ? [5, 5] : [10, 10];
      return { data: ['20260720', '20260721'].map((trade_date, index) => ({
        ts_code: request.params.ts_code,
        trade_date,
        close: closes[index],
        adjusted_close: 999,
      })) };
    }
    if (request.params.ts_code === 'AAA') {
      return { data: [
        { ts_code: 'AAA', trade_date: '20260722', close: 12, adjusted_close: 999 },
        { ts_code: 'AAA', trade_date: '20260723', close: 13, adjusted_close: 999 },
      ] };
    }
    // OLD was fully sold; SUSP remains held but had no counter print. Both
    // legitimately carry their already-frozen prior raw close forward.
    return { data: [] };
  });
  const env = { FEEDBACK_DB: database };
  const first = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-21T22:00:00.000Z'),
    affectedFrom: '2026-07-20', ledgerRevision: 5, batchSize: 50,
  });
  const firstManifest = { ...database.database.prepare(`
    SELECT price_tape_id, tape_through, calendar_dates_json, price_tape_hash,
      price_row_count FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 5
  `).get() };
  const firstRows = database.database.prepare(`
    SELECT ticker, price_date, price_micros, source, source_ref
    FROM ledger_price_tape_rows WHERE price_tape_id = ? ORDER BY ticker, price_date
  `).all(firstManifest.price_tape_id).map(row => ({ ...row }));
  assert.equal(first.priceTapeId, 'raw-close:us:5');
  assert.equal(adapter.calls.length, 5);

  await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-21T22:00:00.000Z'),
    affectedFrom: '2026-07-20', ledgerRevision: 5, batchSize: 50,
  });
  const repeatedManifest = { ...database.database.prepare(`
    SELECT price_tape_id, tape_through, calendar_dates_json, price_tape_hash,
      price_row_count FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 5
  `).get() };
  assert.deepEqual(repeatedManifest, firstManifest);
  assert.equal(adapter.calls.length, 5);

  const extended = await rebuildPortfolioNavHistory(env, 'us', led, {
    adapter,
    now: () => Date.parse('2026-07-23T22:00:00.000Z'),
    affectedFrom: '2026-07-20', ledgerRevision: 5, batchSize: 50,
  });
  const extendedManifest = { ...database.database.prepare(`
    SELECT price_tape_id, tape_through, calendar_dates_json, price_tape_hash,
      price_row_count FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 5
  `).get() };
  const extendedRows = database.database.prepare(`
    SELECT ticker, price_date, price_micros, source, source_ref
    FROM ledger_price_tape_rows WHERE price_tape_id = ? ORDER BY ticker, price_date
  `).all(firstManifest.price_tape_id).map(row => ({ ...row }));
  assert.equal(extended.priceTapeId, first.priceTapeId);
  assert.equal(extendedManifest.price_tape_id, firstManifest.price_tape_id);
  assert.equal(extendedManifest.tape_through, '2026-07-23');
  assert.deepEqual(JSON.parse(extendedManifest.calendar_dates_json), [
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
  ]);
  assert.notEqual(extendedManifest.price_tape_hash, firstManifest.price_tape_hash);
  assert.deepEqual(
    extendedRows.filter(row => row.price_date <= firstManifest.tape_through),
    firstRows,
  );
  assert.deepEqual(extendedRows.filter(row => row.price_date > firstManifest.tape_through), [
    { ticker: 'AAA', price_date: '2026-07-22', price_micros: 12_000_000,
      source: 'tushare:us_daily', source_ref: 'us_daily:close:raw-unadjusted' },
    { ticker: 'AAA', price_date: '2026-07-23', price_micros: 13_000_000,
      source: 'tushare:us_daily', source_ref: 'us_daily:close:raw-unadjusted' },
  ]);
  assert.equal(adapter.calls.length, 10);
  const lastNav = database.database.prepare(`
    SELECT nav_date, market_value_minor, net_value_minor
    FROM ledger_nav_snapshots WHERE portfolio_id = 'us' ORDER BY nav_date DESC LIMIT 1
  `).get();
  assert.deepEqual({ ...lastNav }, {
    nav_date: '2026-07-23', market_value_minor: 18_000, net_value_minor: 303_000,
  });

  // A mutable same-day counter quote is isolated in ledger_prices and cannot
  // alter the historical tape or its hash.
  await persistLedgerValuation({ FEEDBACK_DB: database }, 'us', {
    date: '2026-07-23', cash: 2850, marketValue: 9990, totalAssets: 12840,
    liability: 0, netValue: 12840, units: 3000, unitNav: 4.28,
    sourceRef: 'live-counter-test', valuation: { priceBasis: 'raw_close' }, warnings: [],
  }, [{ ticker: 'AAA', close: 999, source: 'TUSHARE', sourceRef: 'live-counter' }], 5);
  const afterLiveManifest = { ...database.database.prepare(`
    SELECT price_tape_id, tape_through, calendar_dates_json, price_tape_hash,
      price_row_count FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 5
  `).get() };
  const afterLiveRows = database.database.prepare(`
    SELECT ticker, price_date, price_micros, source, source_ref
    FROM ledger_price_tape_rows WHERE price_tape_id = ? ORDER BY ticker, price_date
  `).all(firstManifest.price_tape_id).map(row => ({ ...row }));
  assert.deepEqual(afterLiveManifest, extendedManifest);
  assert.deepEqual(afterLiveRows, extendedRows);
  assert.equal(database.database.prepare(`
    SELECT price_micros FROM ledger_prices
    WHERE portfolio_id = 'us' AND ticker = 'AAA' AND price_date = '2026-07-23'
  `).get().price_micros, 999_000_000);

  // A new ledger revision inherits every common-ticker historical byte from
  // the prior tape. Even if the supplier would now revise old closes, only the
  // newly-held ticker history and future dates are fetched.
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 6 WHERE portfolio_id = 'us'
  `).run();
  supplierRevisedOldHistory = true;
  const crossRevisionCallStart = adapter.calls.length;
  const revisionSixEvents = [...events, {
    event_id: 'buy-new', type: 'BUY', date: '2026-07-24', sequence: 1,
    ticker: 'NEW', quantity: 1, gross_amount: '20', net_cash: '-20',
  }];
  const revisionSix = await rebuildPortfolioNavHistory(env, 'us', {
    market: 'us', portfolio: 'us', ledgerRevision: 6,
    confirmedEvents: revisionSixEvents,
    navRows: [{ date: '2026-07-23', unitNav: 1.01, nav: 1.01 }],
  }, {
    adapter,
    now: () => Date.parse('2026-07-24T22:00:00.000Z'),
    affectedFrom: '2026-07-24', ledgerRevision: 6, batchSize: 50,
  });
  assert.equal(revisionSix.targetThrough, '2026-07-24');
  const childManifest = database.database.prepare(`
    SELECT parent_price_tape_id, inherited_through, tape_through
    FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 6
  `).get();
  assert.deepEqual({ ...childManifest }, {
    parent_price_tape_id: 'raw-close:us:5',
    inherited_through: '2026-07-23',
    tape_through: '2026-07-24',
  });
  const childPrefix = database.database.prepare(`
    SELECT ticker, price_date, price_micros, source, source_ref
    FROM ledger_price_tape_rows
    WHERE price_tape_id = 'raw-close:us:6' AND price_date <= '2026-07-23'
    ORDER BY ticker, price_date
  `).all().map(row => ({ ...row }));
  assert.deepEqual(childPrefix, extendedRows);
  const crossRevisionCalls = adapter.calls.slice(crossRevisionCallStart);
  assert.ok(crossRevisionCalls
    .filter(call => call.request.params.ts_code && call.request.params.ts_code !== 'AAPL')
    .every(call => call.request.params.start_date === '20260724'));
  assert.equal(database.database.prepare(`
    SELECT price_micros FROM ledger_price_tape_rows
    WHERE price_tape_id = 'raw-close:us:6' AND ticker = 'AAA' AND price_date = '2026-07-21'
  `).get().price_micros, 11_000_000);
  assert.deepEqual({ ...database.database.prepare(`
    SELECT nav_date, market_value_minor, net_value_minor
    FROM ledger_nav_snapshots WHERE portfolio_id = 'us' ORDER BY nav_date DESC LIMIT 1
  `).get() }, {
    nav_date: '2026-07-24', market_value_minor: 21_000, net_value_minor: 304_000,
  });
});

test('dirty historical NAV rows are rebuilt from confirmed events and market-day prices', async () => {
  const database = await ledgerDatabase();
  database.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  const insertEvent = database.database.prepare(`
    INSERT INTO ledger_events (
      event_id, lineage_id, event_version, portfolio_id, ledger_revision,
      event_type, trade_date, sequence_no, currency, payload_json,
      source, confirmed_by, confirmed_at
    ) VALUES (?, ?, 1, 'us', ?, ?, ?, ?, 'USD', ?, 'MANUAL', 'test', 1)
  `);
  const capital = {
    event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00', status: 'confirmed',
  };
  const buy = {
    event_id: 'buy-1', type: 'BUY', date: '2026-07-21', ticker: 'AAA', quantity: 10,
    gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
    status: 'confirmed',
  };
  insertEvent.run('capital-1', 'capital-1', 1, 'CAPITAL', '2026-07-20', 1, JSON.stringify(capital));
  insertEvent.run('buy-1', 'buy-1', 2, 'BUY', '2026-07-21', 1, JSON.stringify(buy));
  database.database.prepare(`
    INSERT INTO ledger_prices (
      portfolio_id, ticker, price_date, ledger_revision, price_micros,
      currency, source, source_ref, valuation_json, observed_at
    ) VALUES (
      'us', 'AAA', '2026-07-21', 2, 999000000,
      'USD', 'LEGACY_READ_ONLY_PROJECTION', 'old-adjusted-excel-seed',
      '{"readOnlyProjectionSeed":true,"adjusted":true}', 1
    )
  `).run();
  const kv = new MockKV({
    'ledger:us': JSON.stringify({
      market: 'us',
      portfolio: 'us', currency: 'USD',
      positions: [{ t: 'AAA', n: 'AAA Inc', q: 10, mv: 100, pnl: 0 }],
      confirmedEvents: [capital, buy],
      cash: 900,
      liability: 0,
      units: 1000,
      lastDate: '2026-07-21',
      lastUnitNav: 1,
      baseNetValue: 1000,
      ledgerRevision: 2,
      navRows: [
        { date: '2026-07-20', cash: 1000, marketValue: 0, totalAssets: 1000,
          liability: 0, netValue: 1000, units: 1000, unitNav: 1 },
        { date: '2026-07-21', cash: 900, marketValue: 100, totalAssets: 1000,
          liability: 0, netValue: 1000, units: 1000, unitNav: 1 },
      ],
      navRecalculationRequired: ['2026-07-20'],
    }),
  });
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'us_tradecal') {
      return officialCalendar(request, ['20260720', '20260721', '20260730']);
    }
    assert.equal(dataset, 'us_daily');
    if (request.params.ts_code === 'AAPL') return { data: [
      { ts_code: 'AAPL', trade_date: '20260720', close: 600 },
      { ts_code: 'AAPL', trade_date: '20260721', close: 601 },
      { ts_code: 'AAPL', trade_date: '20260730', close: 610 },
    ] };
    assert.equal(request.params.ts_code, 'AAA');
    return {
      data: [
        { ts_code: 'AAA', trade_date: '20260721', close: 10 },
        { ts_code: 'AAA', trade_date: '20260730', close: 12 },
      ],
      freshness_class: 'eod',
      fetched_at: '2026-07-30T21:30:00.000Z',
    };
  });

  const env = { YC_KV: kv, FEEDBACK_DB: database };
  await persistLedgerValuation(env, 'us', {
    date: '2026-07-31', cash: 900, marketValue: 7770, totalAssets: 8670,
    liability: 0, netValue: 8670, units: 1000, unitNav: 8.67,
    sourceRef: 'stale-target-after-row',
    valuation: { priceBasis: 'legacy_adjusted', adjusted: true }, warnings: [],
  }, [], 2);
  const replay = await updatePortfolioNav(env, 'us', {
    adapter,
    now,
    affectedFrom: '2026-07-20',
    batchSize: 50,
  });
  assert.equal(replay.complete, false);
  assert.equal(replay.phase, 'replay');
  assert.equal(replay.nextPhase, 'materialize');
  assert.equal(kv.values.has('navcache:us'), false);
  const materialized = await updatePortfolioNav(env, 'us', {
    adapter,
    now,
    affectedFrom: '2026-07-20',
    phase: replay.nextPhase,
    targetThrough: replay.targetThrough,
    lastNavDate: replay.lastNavDate,
    previousUnitNav: replay.lastUnitNav,
  });
  assert.equal(materialized.complete, false);
  assert.equal(materialized.phase, 'materialize');
  assert.equal(materialized.nextPhase, 'publish');
  assert.equal(kv.values.has('navcache:us'), false);
  const status = await updatePortfolioNav(env, 'us', {
    adapter,
    now,
    affectedFrom: '2026-07-20',
    phase: materialized.nextPhase,
    targetThrough: materialized.targetThrough,
    lastNavDate: materialized.lastNavDate,
    previousUnitNav: materialized.lastUnitNav,
  });
  assert.equal(status.fallback, false);
  assert.equal(status.complete, true);
  assert.equal(status.phase, 'publish');
  assert.equal(status.rebuiltFrom, '2026-07-20');
  assert.equal(status.appended, '2026-07-30');
  const rows = database.database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, units_micros, unit_nav_micros,
      ledger_revision FROM ledger_nav_snapshots WHERE portfolio_id = 'us' ORDER BY nav_date
  `).all();
  assert.deepEqual(rows.map(row => ({ ...row })), [
    { nav_date: '2026-07-20', cash_minor: 100000, market_value_minor: 0,
      units_micros: 1_000_000_000, unit_nav_micros: 1_000_000, ledger_revision: 2 },
    { nav_date: '2026-07-21', cash_minor: 90000, market_value_minor: 10000,
      units_micros: 1_000_000_000, unit_nav_micros: 1_000_000, ledger_revision: 2 },
    { nav_date: '2026-07-30', cash_minor: 90000, market_value_minor: 12000,
      units_micros: 1_000_000_000, unit_nav_micros: 1_020_000, ledger_revision: 2 },
  ]);
  assert.equal(rows.some(row => row.nav_date === '2026-07-31'), false);
  const rebuiltLedger = JSON.parse(kv.values.get('ledger:us'));
  assert.deepEqual(rebuiltLedger.navRecalculationRequired, []);
  assert.deepEqual({
    price: rebuiltLedger.positions[0].p,
    priceDate: rebuiltLedger.positions[0].priceDate,
    priceSource: rebuiltLedger.positions[0].priceSource,
    priceBasis: rebuiltLedger.positions[0].priceBasis,
    adjusted: rebuiltLedger.positions[0].priceAdjusted,
    priceTapeId: rebuiltLedger.positions[0].priceTapeId,
  }, {
    price: 12,
    priceDate: '2026-07-30',
    priceSource: 'tushare:us_daily',
    priceBasis: 'raw_close',
    adjusted: false,
    priceTapeId: 'raw-close:us:2',
  });
  assert.deepEqual({
    price: rebuiltLedger.sourceHoldings[0].price,
    source: rebuiltLedger.sourceHoldings[0].priceSource,
    basis: rebuiltLedger.sourceHoldings[0].priceBasis,
    adjusted: rebuiltLedger.sourceHoldings[0].adjusted,
  }, {
    price: 12, source: 'tushare:us_daily', basis: 'raw_close', adjusted: false,
  });
  const tapeManifest = database.database.prepare(`
    SELECT price_basis, adjusted, price_source, price_row_count
    FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 2
  `).get();
  assert.deepEqual({ ...tapeManifest }, {
    price_basis: 'raw_close', adjusted: 0,
    price_source: 'tushare:us_daily', price_row_count: 2,
  });
  assert.deepEqual(database.database.prepare(`
    SELECT price_date, price_micros FROM ledger_price_tape_rows
    WHERE price_tape_id = 'raw-close:us:2' ORDER BY price_date
  `).all().map(row => ({ ...row })), [
    { price_date: '2026-07-21', price_micros: 10_000_000 },
    { price_date: '2026-07-30', price_micros: 12_000_000 },
  ]);
  assert.equal(database.database.prepare(`
    SELECT price_micros FROM ledger_prices
    WHERE portfolio_id = 'us' AND ticker = 'AAA' AND price_date = '2026-07-21'
  `).get().price_micros, 999_000_000);
  const exportResponse = await handleLedgerAdminRequest(
    new Request('https://ledger.test/api/admin/ledger/export?portfolio=us'),
    env,
    { actor: 'test' },
  );
  assert.equal(exportResponse.status, 200);
  const exported = await exportResponse.json();
  assert.equal(exported.projection.positions[0].price, 12);
  assert.equal(exported.projection.positions[0].price_basis, 'raw_close');
  assert.equal(exported.projection.positions[0].price_adjusted, false);
  assert.deepEqual(exported.priceRows.map(row => [row.ticker, row.date, row.price]), [
    ['AAA', '2026-07-30', 12],
  ]);
  const health = await ledgerHealth(env);
  assert.equal(health.rawNavReady, true, JSON.stringify(health.rawNavPortfolios));
  assert.equal(health.rawNavPortfolios.us.priceBasis, 'raw_close');
  const verifiedCounter = {
    date: '2026-07-31', cash: 900, marketValue: 130, totalAssets: 1030,
    liability: 0, netValue: 1030, units: 1000, unitNav: 1.03,
    sourceRef: 'rt:raw-counter',
    valuation: {
      source: 'tushare', priceBasis: 'raw_counter', adjusted: false,
      quoteDate: '2026-07-31', sessionVerified: true,
    },
    warnings: [],
  };
  const verifiedCounterPrices = [{
    ticker: 'AAA', date: '2026-07-31', close: 13, source: 'TUSHARE',
    sourceRef: 'rt:AAA', valuation: {
      priceBasis: 'raw_counter', adjusted: false,
      quoteDate: '2026-07-31', sessionVerified: true,
    },
  }];
  await persistLedgerValuation(env, 'us', verifiedCounter, verifiedCounterPrices, 2);
  const counterHealth = await ledgerHealth(env);
  assert.equal(counterHealth.rawNavReady, true);
  assert.equal(counterHealth.rawNavPortfolios.us.currentCounterAfterTape, true);
  assert.equal(counterHealth.rawNavPortfolios.us.expectedCompletedSession, '2026-07-31');

  // Reproduce the production A-share race: the verified price/session remains
  // in D1, but a historical publish has lost the matching NAV row.
  database.database.prepare(`
    DELETE FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' AND nav_date = '2026-07-31'
  `).run();
  const knownSessionGap = await ledgerHealth(env);
  assert.equal(knownSessionGap.rawNavReady, false);
  assert.equal(
    knownSessionGap.rawNavPortfolios.us.reason,
    'RAW_NAV_COMPLETED_SESSION_STALE',
  );
  assert.equal(knownSessionGap.rawNavPortfolios.us.expectedCompletedSession, '2026-07-31');
  assert.equal(knownSessionGap.rawNavPortfolios.us.latestNavDate, '2026-07-30');
  await persistLedgerValuation(env, 'us', verifiedCounter, verifiedCounterPrices, 2);

  await persistLedgerValuation(env, 'us', {
    date: '2026-08-01', cash: 900, marketValue: 140, totalAssets: 1040,
    liability: 0, netValue: 1040, units: 1000, unitNav: 1.04,
    sourceRef: 'rt:raw-counter',
    valuation: {
      source: 'tushare', priceBasis: 'raw_counter', adjusted: false,
      quoteDate: '2026-08-01',
    },
    warnings: [],
  }, [], 2);
  const staleTapeHealth = await ledgerHealth(env);
  assert.equal(staleTapeHealth.rawNavReady, false);
  assert.equal(staleTapeHealth.rawNavPortfolios.us.reason, 'NAV_TARGET_MISMATCH');
});

test('cash-only portfolio uses a market proxy quote to persist daily NAV', async () => {
  const kv = new MockKV({
    'ledger:us': JSON.stringify({
      market: 'us',
      positions: [],
      cash: 1000,
      liability: 0,
      units: 1000,
      lastDate: '2026-07-29',
      lastUnitNav: 1,
      baseNetValue: 1000,
      ledgerRevision: 0,
      navRecalculationRequired: [],
    }),
  });
  const adapter = adapterWith(async (dataset, request) => {
    assert.equal(dataset, 'us_tradecal');
    return {
      data: Array.from({ length: 15 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 6, 16 + index));
        const compact = date.toISOString().slice(0, 10).replaceAll('-', '');
        const weekday = date.getUTCDay();
        return { cal_date: compact, is_open: weekday !== 0 && weekday !== 6 ? 1 : 0 };
      }),
      freshness_class: 'eod',
      fetched_at: '2026-07-30T21:30:00.000Z',
    };
  });
  const database = await ledgerDatabase();

  const status = await updatePortfolioNav(
    { YC_KV: kv, FEEDBACK_DB: database },
    'us',
    { adapter, now },
  );
  assert.equal(status.fallback, false, JSON.stringify(status));
  assert.equal(status.appended, '2026-07-30');
  assert.equal(status.marketValue, 0);
  assert.equal(status.netValue, 1000);
  assert.deepEqual(adapter.calls.map(call => call.dataset), ['us_tradecal']);

  const stored = database.database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, net_value_minor,
      units_micros, unit_nav_micros, ledger_revision
    FROM ledger_nav_snapshots WHERE portfolio_id = 'us'
  `).get();
  assert.deepEqual({ ...stored }, {
    nav_date: '2026-07-30',
    cash_minor: 100000,
    market_value_minor: 0,
    net_value_minor: 100000,
    units_micros: 1_000_000_000,
    unit_nav_micros: 1_000_000,
    ledger_revision: 0,
  });
  const live = JSON.parse(kv.values.get('live:us'));
  assert.deepEqual(live.rows, []);
  const cache = JSON.parse(kv.values.get('navcache:us'));
  assert.equal(cache.navRows.at(-1).nav, 1);
});

test('an unchanged EOD fallback marks the served NAV as the last successful snapshot', async () => {
  const prior = '{"ok":true,"snapshot_id":"last-success","as_of":"2026-07-30"}';
  const kv = new MockKV({
    'ledger:hk': JSON.stringify({
      market: 'hk',
      positions: [{ t: '700.HK', n: 'Tencent', q: 10, mv: 5000, pnl: 0 }],
      cash: 0,
      liability: 0,
      units: 100,
      lastDate: '2026-07-30',
      lastUnitNav: 50,
      baseNetValue: 5000,
    }),
    'live:hk': JSON.stringify({
      rows: [{ date: '2026-07-30', unitNav: 50, netValue: 5000 }],
    }),
    'navcache:hk': prior,
  });
  const adapter = adapterWith(async (dataset, request) => {
    if (dataset === 'hk_tradecal') return officialCalendar(request, ['20260730']);
    if (dataset === 'rt_hk_k') throw new Error('permission unavailable');
    assert.equal(dataset, 'hk_daily');
    return {
      data: [{ ts_code: '00700.HK', trade_date: '20260730', close: 500 }],
      freshness_class: 'eod',
      fetched_at: '2026-07-31T10:30:00.000Z',
    };
  });
  const status = await updatePortfolioNav(
    { YC_KV: kv },
    'hk',
    { adapter, now: () => Date.parse('2026-07-31T10:30:00.000Z') },
  );
  assert.equal(status.fallback, true);
  assert.equal(status.pricing_fallback, 'latest_eod_snapshot');
  assert.equal(status.reason, 'latest_realtime_unavailable_eod_not_newer');
  assert.equal(kv.values.get('navcache:hk'), prior);
});

test('public portfolio pages are database-snapshot-only with no workbook input path', async () => {
  const portfolioScript = await readFile(path.join(ROOT, 'assets/yc-portfolios.js'), 'utf8');
  assert.doesNotMatch(portfolioScript, /readWorkbook|YC\.analyze|A\.analyze|Math\.random/);

  for (const locale of ['', 'cn', 'en']) {
    for (const market of ['a', 'hk', 'us']) {
      const file = path.join(ROOT, locale, `fund-${market}.html`);
      const source = await readFile(file, 'utf8');
      assert.deepEqual(source.match(/\/api\/nav\/(?:a|hk|us)/g), [`/api/nav/${market}`]);
      assert.match(source, /if\(await bootCache\(\)\) return;/);
      assert.doesNotMatch(source, /XLSX|\.xlsx|\.xlsm|assets\/data|YC\.analyze/);
      assert.doesNotMatch(source, /showOpenFilePicker|indexedDB|dataTransfer|dropzone|filepick|FileReader/);
      assert.doesNotMatch(source, /URLSearchParams|bootHandle|bootFetch|loadArrayBuffer|fetchBenchmarks|\/api\/benchmark/);
    }
  }
  const [wrangler, workerSource] = await Promise.all([
    readFile(path.join(ROOT, 'wrangler.toml'), 'utf8'),
    readFile(path.join(ROOT, 'worker/worker.js'), 'utf8'),
  ]);
  assert.match(wrangler, /"30 10 \* \* \*"/);
  assert.match(wrangler, /"\* \* \* \* \*"/);
  assert.match(wrangler, /"\*\/2 \* \* \* \*"/);
  assert.match(workerSource, /cron:asia-eod/);
  assert.match(workerSource, /cron === ['"]\* \* \* \* \*['"]/);
  assert.match(workerSource, /cron === ['"]\*\/2 \* \* \* \*['"]/);
});
