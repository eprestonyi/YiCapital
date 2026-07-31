import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import worker, {
  benchmarkSnapshotIsTushare,
  portfolioDataset,
  portfolioRealtimeDataset,
  prewarmBenchmark,
  tusharePortfolioQuote,
  updatePortfolioNav,
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

test('portfolio quote routing is A/HK realtime-first and US EOD-only', async () => {
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
  const hkQuote = await tusharePortfolioQuote(hkAdapter, '700.HK', 'hk', now);
  assert.equal(hkQuote.quote_mode, 'realtime');
  assert.equal(hkQuote.date, '2026-07-30');
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
  const adapter = adapterWith(async dataset => {
    if (dataset === 'rt_hk_k') throw new Error('permission unavailable');
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

test('public portfolio boot is snapshot-only; local workbooks remain explicit previews', async () => {
  const portfolioScript = await readFile(path.join(ROOT, 'assets/yc-portfolios.js'), 'utf8');
  assert.doesNotMatch(portfolioScript, /readWorkbook|YC\.analyze|A\.analyze|Math\.random/);

  for (const locale of ['', 'cn', 'en']) {
    for (const market of ['a', 'hk', 'us']) {
      const file = path.join(ROOT, locale, `fund-${market}.html`);
      const source = await readFile(file, 'utf8');
      assert.match(source, /bootCache\(\);/);
      assert.equal((source.match(/\bbootHandle\s*\(/g) || []).length, 1);
      assert.doesNotMatch(source, /await\s+bootHandle\s*\(/);
    }
  }
  const [wrangler, workerSource] = await Promise.all([
    readFile(path.join(ROOT, 'wrangler.toml'), 'utf8'),
    readFile(path.join(ROOT, 'worker/worker.js'), 'utf8'),
  ]);
  assert.match(wrangler, /"30 10 \* \* \*"/);
  assert.match(workerSource, /cron:asia-eod/);
});
