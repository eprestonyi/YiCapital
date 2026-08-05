import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { persistPublicPortfolioSnapshot } from '../worker/ledger-store.js';
import worker from '../worker/worker.js';

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
}

class D1Database {
  constructor(sql) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(sql);
  }

  prepare(sql) { return new D1Statement(this.database, sql); }
}

async function d1Fixture() {
  const sql = (await Promise.all([
    '0001_user_feedback.sql',
    '0002_portfolio_ledger.sql',
    '0003_frozen_price_tapes.sql',
    '0004_auth_sessions.sql',
    '0005_public_portfolio_snapshots.sql',
  ].map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')))).join('\n');
  return new D1Database(sql);
}

function kvStore(initial) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [] }; },
  };
}

function rows(count, offset) {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    return {
      date,
      nav: 1 + index * 0.001 + offset,
      divPerUnit: index === 20 ? 0.01 : 0,
      units: 123456,
      marketValue: 987654321,
      cash: 123456789,
      liability: 24680,
      secretTicker: 'DO-NOT-LEAK',
    };
  });
}

function renderableNavSnapshot(market, navRows, snapshotId) {
  const history = navRows.map((row, index) => ({
    date: row.date,
    ret: index === 0
      ? 0
      : (Number(row.nav) + Number(row.divPerUnit || 0)) / Number(navRows[index - 1].nav) - 1,
  }));
  const metrics = {
    days: history.length,
    totalRet: 0.1,
    annRet: 0.1,
    vol: 0.02,
    sharpe: 1,
    sortino: 1,
    calmar: 1,
    maxDD: -0.01,
    winRate: 0.6,
    plRatio: 1.2,
    var95: -0.01,
    cvar95: -0.02,
    skew: 0,
    kurt: 0,
  };
  const scenario = {
    model: 'noncentral-t',
    nDays: 2,
    p50: 0,
    p5: -0.01,
    p1: -0.02,
    probHalf: 0,
    pathP5: [1, 0.99],
    pathP50: [1, 1],
    pathP95: [1, 1.01],
  };
  return {
    ok: true,
    enabled: true,
    portfolio: market,
    ledgerRevision: 0,
    snapshot_id: snapshotId,
    source: 'portfolio-ledger',
    as_of: navRows.at(-1).date,
    fetched_at: `${navRows.at(-1).date}T08:00:00.000Z`,
    freshness_class: 'eod',
    freshness: { class: 'eod', stale: false, fallback: null },
    cacheVersion: 3,
    historyComplete: true,
    history,
    navRows,
    curve: history.map((row, index) => ({ date: row.date, v: 10000 + index * 10 })),
    metrics,
    statistics: metrics,
    hist: { lo: -0.02, width: 0.01, counts: [2, 3], normal: [2.2, 2.8] },
    varTable: [0.95, 0.98, 0.99].map(level => ({
      level,
      normal: -0.01,
      cf: -0.011,
      empirical: -0.012,
      cvar: -0.013,
    })),
    stress: {
      model: 'noncentral-t',
      crash: scenario,
      bear: scenario,
      grind: scenario,
    },
    status: { stale: [], missing: [], fallback: false },
  };
}

test('entry market returns every common close without exposing raw portfolio fields', async () => {
  const count = 240;
  const labels = { hk: 'HSI', us: 'S&P 500', a: 'HS300' };
  const endpoints = { hk: 'index_global', us: 'index_global', a: 'index_daily' };
  const initial = {};
  for (const [market, label] of Object.entries(labels)) {
    const navRows = rows(count, market === 'us' ? 0.2 : market === 'a' ? 0.4 : 0);
    const navSnapshot = renderableNavSnapshot(market, navRows, `kv-${market}-current`);
    navSnapshot.status = { stale: ['DO-NOT-LEAK'], marketValue: 555555555 };
    initial['navcache:' + market] = JSON.stringify(navSnapshot);
    initial['bmset:' + market] = JSON.stringify({
      ok: true,
      data: {
        [label]: navRows.map((row, index) => ({ date: row.date, close: 1000 + index * 2 })),
      },
      source: 'tushare',
      sources: { [label]: `tushare:${endpoints[market]}` },
      source_meta: {
        [label]: {
          source: `tushare:${endpoints[market]}`,
          source_endpoint: endpoints[market],
          freshness_class: 'eod',
        },
      },
      stale: false,
      fetched: '2026-07-30T00:00:00.000Z',
    });
  }

  const response = await worker.fetch(
    new Request('https://portal.test/api/entry-market'),
    { YC_KV: kvStore(initial), ALLOWED_ORIGIN: 'https://www.yicapital.co' },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  for (const market of Object.keys(labels)) {
    const snapshot = body.markets[market];
    assert.equal(snapshot.formatVersion, 3);
    assert.equal(snapshot.cacheVersion, 3);
    assert.equal(snapshot.points.length, count);
    assert.equal(snapshot.pointCount, count);
    assert.deepEqual(snapshot.points[0], ['2025-01-01', 100, 100]);
    assert.equal(snapshot.start, '2025-01-01');
    assert.equal(snapshot.end, rows(count, 0).at(-1).date);
    assert.equal(snapshot.missingCloseCount, 0);
    assert.equal(snapshot.coverage, 1);
    assert.equal(snapshot.review, true);
  }
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    'DO-NOT-LEAK', 'marketValue', 'cash', 'liability', 'units', 'secretTicker', 'navRows',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
});

test('entry market flags A-share NAV trading-day holes without fabricating closes', async () => {
  const benchmarkRows = rows(34, 0).map((row, index) => ({
    date: row.date,
    close: 1000 + index * 3,
  }));
  const missingDates = new Set(benchmarkRows.slice(14, 18).map(row => row.date));
  const navRows = rows(34, 0.4).filter(row => !missingDates.has(row.date));
  const response = await worker.fetch(
    new Request('https://portal.test/api/entry-market'),
    {
      YC_KV: kvStore({
        'navcache:a': JSON.stringify({
          ...renderableNavSnapshot('a', navRows, 'kv-a-with-holes'),
          status: { stale: [], missing: [] },
        }),
        'bmset:a': JSON.stringify({
          ok: true,
          data: { HS300: benchmarkRows },
          source: 'tushare',
          sources: { HS300: 'tushare:index_daily' },
          source_meta: {
            HS300: {
              source: 'tushare:index_daily',
              source_endpoint: 'index_daily',
              freshness_class: 'eod',
            },
          },
          stale: false,
          fetched: '2026-07-30T00:00:00.000Z',
        }),
      }),
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 200);
  const snapshot = (await response.json()).markets.a;
  assert.equal(snapshot.pointCount, 30);
  assert.equal(snapshot.missingCloseCount, 4);
  assert.equal(snapshot.coverage, 0.882353);
  assert.equal(snapshot.review, true);
  assert.deepEqual(
    snapshot.points.map(point => point[0]),
    benchmarkRows.map(row => row.date).filter(date => !missingDates.has(date)),
  );
  snapshot.points.flatMap(point => point.slice(1)).forEach(value => {
    assert.equal(Number.isFinite(value) && value > 0, true);
  });
});

test('entry market prefers the D1 public snapshot when D1 and legacy KV disagree', async () => {
  const database = await d1Fixture();
  const d1Rows = rows(32, 0.8);
  const kvRows = rows(24, 0.1);
  const benchmarkRows = d1Rows.map((row, index) => ({
    date: row.date,
    close: 1000 + index * 3,
  }));
  const d1Snapshot = renderableNavSnapshot('a', d1Rows, 'd1-a-current');
  await persistPublicPortfolioSnapshot(
    { FEEDBACK_DB: database },
    'a',
    0,
    d1Snapshot,
    {
      pf: 'a',
      ranAt: `${d1Rows.at(-1).date}T08:00:00.000Z`,
      ledgerRevision: 0,
      complete: true,
      fallback: false,
    },
  );

  const response = await worker.fetch(
    new Request('https://portal.test/api/entry-market'),
    {
      FEEDBACK_DB: database,
      YC_KV: kvStore({
        'navcache:a': JSON.stringify(
          renderableNavSnapshot('a', kvRows, 'kv-a-stale'),
        ),
        'bmset:a': JSON.stringify({
          ok: true,
          data: { HS300: benchmarkRows },
          source: 'tushare',
          sources: { HS300: 'tushare:index_daily' },
          source_meta: {
            HS300: {
              source: 'tushare:index_daily',
              source_endpoint: 'index_daily',
              freshness_class: 'eod',
            },
          },
          stale: false,
          fetched: '2026-08-05T08:00:00.000Z',
        }),
      }),
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.markets.a.pointCount, d1Rows.length);
  assert.equal(body.markets.a.end, d1Rows.at(-1).date);
  assert.equal(body.markets.a.navAsOf, d1Rows.at(-1).date);
  assert.equal(body.markets.a.review, false);
  assert.notEqual(body.markets.a.pointCount, kvRows.length);
  assert.equal(JSON.stringify(body).includes('secretTicker'), false);
});
