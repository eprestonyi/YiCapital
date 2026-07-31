import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/worker.js';

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

test('entry market returns every common close without exposing raw portfolio fields', async () => {
  const count = 240;
  const labels = { hk: 'HSI ETF', us: 'S&P 500', a: 'HS300' };
  const initial = {};
  for (const [market, label] of Object.entries(labels)) {
    const navRows = rows(count, market === 'us' ? 0.2 : market === 'a' ? 0.4 : 0);
    initial['navcache:' + market] = JSON.stringify({
      ok: true,
      enabled: true,
      historyComplete: true,
      cacheVersion: 2,
      asOf: navRows.at(-1).date,
      navRows,
      status: { stale: ['DO-NOT-LEAK'], marketValue: 555555555 },
    });
    initial['bmset:' + market] = JSON.stringify({
      ok: true,
      data: {
        [label]: navRows.map((row, index) => ({ date: row.date, close: 1000 + index * 2 })),
      },
      sources: { [label]: market === 'a' ? 'tushare' : 'yahoo' },
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
          ok: true,
          enabled: true,
          historyComplete: true,
          cacheVersion: 2,
          asOf: navRows.at(-1).date,
          navRows,
          status: { stale: [], missing: [] },
        }),
        'bmset:a': JSON.stringify({
          ok: true,
          data: { HS300: benchmarkRows },
          sources: { HS300: 'tushare' },
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
