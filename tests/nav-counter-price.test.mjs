import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  freezeLedgerPriceTape,
  loadFrozenLedgerPriceTape,
  materializeLedgerKv,
  persistLedgerValuation,
} from '../worker/ledger-store.js';
import {
  rebuildPortfolioNavHistory,
  updatePortfolioNav,
} from '../worker/worker.js';

const RISK_MODEL_CONFIG = {
  model: 'noncentral-t', method: 'moment-fit-conditional-monte-carlo',
  modelVersion: 'yc-risk-js-v2', fittedPoolSize: 200000, nSims: 10000,
  seeds: { pool: 0x59494341, crash: 17, bear: 18, grind: 19 },
};

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

class MemoryKv {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
    this.puts = [];
  }

  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) {
    this.puts.push({ key, value });
    this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
}

async function ledgerEnvironment() {
  const migration = (await Promise.all([
    '../migrations/0002_portfolio_ledger.sql',
    '../migrations/0003_frozen_price_tapes.sql',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  return {
    FEEDBACK_DB: new D1Database(migration),
    YC_KV: new MemoryKv(),
  };
}

async function freezeTape(env, portfolio, revision, {
  from,
  through = from,
  calendarDates = [through],
  prices = [],
} = {}) {
  const market = portfolio === 'a' ? 'daily' : portfolio === 'hk' ? 'hk_daily' : 'us_daily';
  const calendar = portfolio === 'a'
    ? 'trade_cal'
    : portfolio === 'hk' ? 'hk_tradecal' : 'us_tradecal';
  const priceSource = `tushare:${market}`;
  return freezeLedgerPriceTape(env, portfolio, {
    tapeFrom: from,
    tapeThrough: through,
    calendarFrom: calendarDates[0],
    calendarDates,
    requiredTickers: [...new Set(prices.map(row => row.ticker))],
    priceBasis: 'raw_close',
    adjusted: false,
    priceSource,
    calendarSource: `tushare:${calendar}`,
    calendarSourceRef: `official:${calendar}`,
    priceRows: prices.map(row => ({
      ...row,
      source: priceSource,
      sourceRef: `${market}:${row.ticker}:${row.date}`,
    })),
  }, revision);
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

function insertConfirmedEvent(database, {
  portfolio = 'a',
  currency = 'CNY',
  eventId,
  revision,
  eventType,
  date,
  sequence,
  payload,
}) {
  database.prepare(`
    INSERT INTO ledger_events (
      event_id, lineage_id, event_version, portfolio_id, ledger_revision,
      event_type, trade_date, sequence_no, currency, payload_json,
      source, confirmed_by, confirmed_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'test', 1)
  `).run(
    eventId,
    eventId,
    portfolio,
    revision,
    eventType,
    date,
    sequence,
    currency,
    JSON.stringify({
      ...payload,
      event_id: eventId,
      type: eventType,
      event_type: eventType,
      date,
      trade_date: date,
      sequence,
      status: 'confirmed',
    }),
  );
}

async function assertSameDayCounterRefresh({
  portfolio,
  currency,
  ticker,
  requestTicker,
  realtimeDataset,
  eodDataset,
  sessionCalendarDataset,
  calendarDataset,
  calendarTicker,
}) {
  const env = await ledgerEnvironment();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = ?`)
    .run(portfolio);
  insertConfirmedEvent(database, {
    portfolio, currency, eventId: `capital-${portfolio}`, revision: 1, eventType: 'CAPITAL',
    date: '2026-07-29', sequence: 1,
    payload: {
      shareholder: 'LP1', subscription: '1000.00', redemption: '0', unit_price: '1.00',
    },
  });
  insertConfirmedEvent(database, {
    portfolio, currency, eventId: `buy-${portfolio}`, revision: 2, eventType: 'BUY',
    date: '2026-07-29', sequence: 1,
    payload: {
      ticker, name: 'Counter-priced holding', quantity: 10,
      gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
    },
  });

  await persistLedgerValuation(env, portfolio, {
    date: '2026-07-29', cash: 900, marketValue: 80, totalAssets: 980,
    liability: 0, netValue: 980, units: 1000, unitNav: 0.98,
    sourceRef: 'daily:raw-close', valuation: { priceBasis: 'RAW_CLOSE' }, warnings: [],
  }, [{
    ticker, close: 8, source: 'TUSHARE', sourceRef: `daily:${requestTicker}`,
    valuation: { priceBasis: 'RAW_CLOSE' },
  }], 2);
  await freezeTape(env, portfolio, 2, {
    from: '2026-07-29',
    prices: [{ ticker, date: '2026-07-29', close: 8 }],
  });
  await materializeLedgerKv(env, portfolio, { expectedLedgerRevision: 2 });
  const materializedLedgerRaw = env.YC_KV.values.get(`ledger:${portfolio}`);
  const stressScenario = {
    model: 'noncentral-t', fixture: portfolio, nDays: 2,
    p50: 1, p5: 0.99, p1: 0.98, probHalf: 0,
    pathP5: [1, 0.99], pathP50: [1, 1], pathP95: [1, 1.01],
  };
  const fullStress = {
    model: 'noncentral-t', fixture: portfolio,
    crash: stressScenario, bear: stressScenario, grind: stressScenario,
  };
  const initialHistory = [{ date: '2026-07-29', ret: 0 }];
  const initialHistorySha256 = sha256(JSON.stringify(
    initialHistory.map(row => [row.date, row.ret]),
  ));
  env.YC_KV.values.set(`navcache:${portfolio}`, JSON.stringify({
    portfolio,
    ledgerRevision: 2,
    history: initialHistory,
    navRows: [{
      date: '2026-07-29', nav: 0.98, unitNav: 0.98,
      cash: 900, marketValue: 80, totalAssets: 980, netValue: 980, units: 1000,
    }],
    stress: fullStress,
    risk_snapshot: {
      status: 'current', portfolio_id: portfolio, ledger_revision: 2,
      input_as_of: '2026-07-29', history_through: '2026-07-29',
      observation_count: 1,
      history_sha256: initialHistorySha256,
      current_history_sha256: initialHistorySha256,
      output_sha256: sha256(JSON.stringify(fullStress)),
      config_sha256: sha256(JSON.stringify(RISK_MODEL_CONFIG)),
      model_version: 'yc-risk-js-v2', code_version: 'portfolio-risk-v2',
      adjusted: false, calculated_at: '2026-07-29T22:00:00.000Z',
    },
  }));

  let counterClose = 10;
  let officialEodClose = null;
  let sessionDate = '2026-07-30';
  const compactSessionDate = () => sessionDate.replaceAll('-', '');
  const adapter = {
    async query(dataset, request) {
      if (dataset === sessionCalendarDataset) {
        if (dataset === 'trade_cal') assert.equal(request.params.exchange, 'SSE');
        return {
          ...officialCalendar(request, [compactSessionDate()]),
          freshness_class: 'static',
          fetched_at: '2026-07-30T07:00:00.000Z',
        };
      }
      if (dataset === realtimeDataset) {
        assert.equal(request.params.ts_code, requestTicker);
        if (officialEodClose != null) throw new Error('realtime session has closed');
        return {
          data: [{
            ts_code: requestTicker, close: counterClose,
            ...(portfolio === 'hk' ? {} : { trade_time: `${sessionDate} 14:00:00` }),
          }],
          freshness_class: 'intraday_snapshot',
          fetched_at: '2026-07-30T07:00:00.000Z',
        };
      }
      if (dataset === eodDataset) {
        assert.equal(request.params.ts_code, requestTicker);
        assert.notEqual(officialEodClose, null);
        return {
          data: [{
            ts_code: requestTicker, close: officialEodClose,
            trade_date: compactSessionDate(),
          }],
          freshness_class: 'eod',
          fetched_at: '2026-07-30T10:00:00.000Z',
        };
      }
      assert.equal(dataset, calendarDataset);
      assert.equal(request.params.ts_code, calendarTicker);
      return {
        data: [{ ts_code: calendarTicker, trade_date: compactSessionDate(), close: 4000 }],
        freshness_class: 'eod',
        fetched_at: '2026-07-30T08:00:00.000Z',
      };
    },
  };
  let nowValue = Date.parse('2026-07-30T06:00:00.000Z');
  const now = () => nowValue;

  const first = await updatePortfolioNav(env, portfolio, { adapter, now });
  assert.equal(first.appended, '2026-07-30');
  assert.equal(first.marketValue, 100);
  assert.equal(first.netValue, 1000);
  assert.equal(first.upToDate, undefined);
  assert.equal(env.YC_KV.values.get(`ledger:${portfolio}`), materializedLedgerRaw);
  const firstCache = JSON.parse(env.YC_KV.values.get(`navcache:${portfolio}`));
  assert.deepEqual(firstCache.stress, fullStress);
  assert.equal(firstCache.risk_snapshot.status, 'stale');
  assert.equal(firstCache.risk_snapshot.input_as_of, '2026-07-29');
  assert.equal(firstCache.risk_snapshot.current_input_as_of, '2026-07-30');
  assert.equal(firstCache.risk_snapshot.stale_by_sessions, 1);
  const intradayNavValuation = JSON.parse(database.prepare(`
    SELECT valuation_json FROM ledger_nav_snapshots
    WHERE portfolio_id = ? AND nav_date = '2026-07-30'
  `).get(portfolio).valuation_json);
  assert.equal(intradayNavValuation.priceBasis, 'raw_counter');
  assert.equal(intradayNavValuation.adjusted, false);
  assert.equal(intradayNavValuation.quoteDate, '2026-07-30');
  assert.equal(intradayNavValuation.quoteSources[0].source, `tushare:${realtimeDataset}`);
  const intradayPriceValuation = JSON.parse(database.prepare(`
    SELECT valuation_json FROM ledger_prices
    WHERE portfolio_id = ? AND ticker = ? AND price_date = '2026-07-30'
  `).get(portfolio, ticker).valuation_json);
  assert.equal(intradayPriceValuation.priceBasis, 'raw_counter');
  assert.equal(intradayPriceValuation.adjusted, false);

  counterClose = 12;
  const second = await updatePortfolioNav(env, portfolio, { adapter, now });
  assert.equal(second.appended, '2026-07-30');
  const secondCache = JSON.parse(env.YC_KV.values.get(`navcache:${portfolio}`));
  assert.equal(secondCache.risk_snapshot.status, 'stale');
  assert.equal(secondCache.risk_snapshot.input_as_of, '2026-07-29');
  assert.equal(second.marketValue, 120);
  assert.equal(second.netValue, 1020);
  assert.equal(second.upToDate, undefined);
  assert.equal(env.YC_KV.values.get(`ledger:${portfolio}`), materializedLedgerRaw);
  assert.deepEqual(JSON.parse(env.YC_KV.values.get(`navcache:${portfolio}`)).stress, fullStress);

  officialEodClose = 13;
  nowValue = Date.parse('2026-07-30T10:00:00.000Z');
  const officialClose = await updatePortfolioNav(env, portfolio, { adapter, now });
  assert.equal(officialClose.appended, '2026-07-30');
  assert.equal(officialClose.marketValue, 130);
  assert.equal(officialClose.netValue, 1030);
  assert.equal(officialClose.pricing_fallback, 'latest_eod_snapshot');
  assert.equal(officialClose.priceBasis, 'raw_close');
  assert.equal(env.YC_KV.values.get(`ledger:${portfolio}`), materializedLedgerRaw);
  assert.deepEqual(JSON.parse(env.YC_KV.values.get(`navcache:${portfolio}`)).stress, fullStress);

  const navRows = database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, total_assets_minor,
      net_value_minor, unit_nav_micros
    FROM ledger_nav_snapshots WHERE portfolio_id = ? ORDER BY nav_date
  `).all(portfolio).map(row => ({ ...row }));
  assert.deepEqual(navRows, [
    {
      nav_date: '2026-07-29', cash_minor: 90000, market_value_minor: 8000,
      total_assets_minor: 98000, net_value_minor: 98000, unit_nav_micros: 980000,
    },
    {
      nav_date: '2026-07-30', cash_minor: 90000, market_value_minor: 13000,
      total_assets_minor: 103000, net_value_minor: 103000, unit_nav_micros: 1030000,
    },
  ]);
  const prices = database.prepare(`
    SELECT price_date, price_micros FROM ledger_prices
    WHERE portfolio_id = ? AND ticker = ? ORDER BY price_date
  `).all(portfolio, ticker).map(row => ({ ...row }));
  assert.deepEqual(prices, [
    { price_date: '2026-07-29', price_micros: 8_000_000 },
    { price_date: '2026-07-30', price_micros: 13_000_000 },
  ]);
  const officialNavValuation = JSON.parse(database.prepare(`
    SELECT valuation_json FROM ledger_nav_snapshots
    WHERE portfolio_id = ? AND nav_date = '2026-07-30'
  `).get(portfolio).valuation_json);
  assert.equal(officialNavValuation.priceBasis, 'raw_close');
  assert.equal(officialNavValuation.adjusted, false);
  assert.equal(officialNavValuation.quoteDate, '2026-07-30');
  assert.equal(officialNavValuation.quoteSources[0].source, `tushare:${eodDataset}`);
  const officialPriceValuation = JSON.parse(database.prepare(`
    SELECT valuation_json FROM ledger_prices
    WHERE portfolio_id = ? AND ticker = ? AND price_date = '2026-07-30'
  `).get(portfolio, ticker).valuation_json);
  assert.equal(officialPriceValuation.priceBasis, 'raw_close');
  assert.equal(officialPriceValuation.adjusted, false);
  assert.equal(officialPriceValuation.quoteDate, '2026-07-30');
  const publishedLive = JSON.parse(env.YC_KV.values.get(`live:${portfolio}`));
  assert.equal(publishedLive.holdings[0].priceBasis, 'raw_close');
  assert.equal(publishedLive.holdings[0].adjusted, false);

  sessionDate = '2026-07-31';
  counterClose = 14;
  officialEodClose = null;
  nowValue = Date.parse('2026-07-31T06:00:00.000Z');
  const nextSession = await updatePortfolioNav(env, portfolio, { adapter, now });
  assert.equal(nextSession.appended, '2026-07-31');
  assert.equal(nextSession.marketValue, 140);
  assert.equal(nextSession.netValue, 1040);
  const nextCache = JSON.parse(env.YC_KV.values.get(`navcache:${portfolio}`));
  assert.deepEqual(nextCache.navRows.at(-1), {
    date: '2026-07-31', nav: 1.04, ret: 0.0097087379,
    unitNav: 1.04, units: 1000, marketValue: 140, cash: 900,
    liability: 0, totalAssets: 1040, netValue: 1040,
    mv: 1040, divPerUnit: 0,
  });

  // Losing the mutable live key must not prevent the cached intraday row from
  // being replaced by the verified official raw close for the same session.
  env.YC_KV.values.delete(`live:${portfolio}`);
  officialEodClose = 15;
  nowValue = Date.parse('2026-07-31T10:00:00.000Z');
  const nextOfficialClose = await updatePortfolioNav(env, portfolio, { adapter, now });
  assert.equal(nextOfficialClose.appended, '2026-07-31');
  assert.equal(nextOfficialClose.priceBasis, 'raw_close');
  assert.equal(nextOfficialClose.netValue, 1050);
}

test('A/HK counter quotes overwrite only the current market-date NAV on every realtime refresh', async () => {
  await assertSameDayCounterRefresh({
    portfolio: 'a', currency: 'CNY', ticker: '600919.SS', requestTicker: '600919.SH',
    realtimeDataset: 'rt_k', eodDataset: 'daily',
    sessionCalendarDataset: 'trade_cal',
    calendarDataset: 'index_daily', calendarTicker: '000300.SH',
  });
  await assertSameDayCounterRefresh({
    portfolio: 'hk', currency: 'HKD', ticker: '0700.HK', requestTicker: '00700.HK',
    realtimeDataset: 'rt_hk_k', eodDataset: 'hk_daily',
    sessionCalendarDataset: 'hk_tradecal',
    calendarDataset: 'index_global', calendarTicker: 'HSI',
  });
});

test('same-day Confirm uses current D1 facts, inherits the parent tape, and materializes counter NAV', async () => {
  const env = await ledgerEnvironment();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'a'`)
    .run();
  insertConfirmedEvent(database, {
    portfolio: 'a', currency: 'CNY', eventId: 'capital-old', revision: 1,
    eventType: 'CAPITAL', date: '2026-07-29', sequence: 1,
    payload: { shareholder: 'LP1', subscription: '1000.00', redemption: '0', unit_price: '1.00' },
  });
  insertConfirmedEvent(database, {
    portfolio: 'a', currency: 'CNY', eventId: 'buy-old', revision: 2,
    eventType: 'BUY', date: '2026-07-29', sequence: 1,
    payload: {
      ticker: '600919.SS', name: 'Bank', quantity: 10,
      gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
    },
  });
  await persistLedgerValuation(env, 'a', {
    date: '2026-07-29', cash: 900, marketValue: 80, totalAssets: 980,
    liability: 0, netValue: 980, units: 1000, unitNav: 0.98,
    source: 'tushare:daily', sourceRef: 'daily:raw-close',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: '600919.SS', date: '2026-07-29', close: 8, source: 'tushare:daily:raw_close',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 2);
  const parentTape = await freezeTape(env, 'a', 2, {
    from: '2026-07-29',
    prices: [{ ticker: '600919.SS', date: '2026-07-29', close: 8 }],
  });
  const oldLedger = await materializeLedgerKv(env, 'a', { expectedLedgerRevision: 2 });
  assert.equal(oldLedger.positions[0].q, 10);
  assert.equal(oldLedger.cash, 900);

  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 3 WHERE portfolio_id = 'a'`)
    .run();
  insertConfirmedEvent(database, {
    portfolio: 'a', currency: 'CNY', eventId: 'buy-current', revision: 3,
    eventType: 'BUY', date: '2026-07-30', sequence: 2,
    payload: {
      ticker: '600919.SS', name: 'Bank', quantity: 10,
      gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
    },
  });
  const adapter = {
    async query(dataset, request) {
      if (dataset === 'trade_cal') return officialCalendar(request, ['20260730']);
      assert.equal(dataset, 'rt_k');
      assert.equal(request.params.ts_code, '600919.SH');
      return {
        data: [{ ts_code: '600919.SH', close: 11, trade_time: '2026-07-30 13:59:00' }],
        freshness_class: 'intraday_snapshot', fetched_at: '2026-07-30T06:00:00.000Z',
      };
    },
  };
  const status = await updatePortfolioNav(env, 'a', {
    adapter,
    ledgerRevision: 3,
    affectedFrom: '2026-07-30',
    now: () => Date.parse('2026-07-30T06:00:00.000Z'),
  });
  assert.equal(status.complete, true, JSON.stringify(status));
  assert.equal(status.appended, '2026-07-30');
  assert.equal(status.marketValue, 220);
  assert.equal(status.netValue, 1020);
  const childTape = await loadFrozenLedgerPriceTape(env, 'a', 3);
  assert.equal(childTape.parentPriceTapeId, parentTape.priceTapeId);
  assert.equal(childTape.inheritedThrough, parentTape.tapeThrough);
  assert.equal(childTape.priceTapeHash === parentTape.priceTapeHash, false);
  const currentLedger = JSON.parse(env.YC_KV.values.get('ledger:a'));
  assert.equal(currentLedger.ledgerRevision, 3);
  assert.equal(currentLedger.positions[0].q, 20);
  assert.equal(currentLedger.cash, 800);
  assert.equal(currentLedger.navRows.at(-1).date, '2026-07-30');
  assert.equal(currentLedger.navRows.at(-1).ledgerRevision, 3);
});

test('same-day cash-only capital Confirm materializes from a verified current session', async () => {
  const env = await ledgerEnvironment();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'a'`)
    .run();
  insertConfirmedEvent(database, {
    portfolio: 'a', currency: 'CNY', eventId: 'cash-capital-old', revision: 1,
    eventType: 'CAPITAL', date: '2026-07-29', sequence: 1,
    payload: { shareholder: 'LP1', subscription: '1000.00', redemption: '0', unit_price: '1.00' },
  });
  await persistLedgerValuation(env, 'a', {
    date: '2026-07-29', cash: 1000, marketValue: 0, totalAssets: 1000,
    liability: 0, netValue: 1000, units: 1000, unitNav: 1,
    source: 'tushare:trade_cal', sourceRef: 'cash-only',
    valuation: { priceBasis: 'cash_only', adjusted: false }, warnings: [],
  }, [], 1);
  const parentTape = await freezeTape(env, 'a', 1, { from: '2026-07-29', prices: [] });
  await materializeLedgerKv(env, 'a', { expectedLedgerRevision: 1 });

  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'a'`)
    .run();
  insertConfirmedEvent(database, {
    portfolio: 'a', currency: 'CNY', eventId: 'cash-capital-current', revision: 2,
    eventType: 'CAPITAL', date: '2026-07-30', sequence: 2,
    payload: { shareholder: 'LP1', subscription: '100.00', redemption: '0', unit_price: '1.00' },
  });
  const adapter = {
    async query(dataset, request) {
      assert.equal(dataset, 'trade_cal');
      return officialCalendar(request, ['20260730']);
    },
  };
  const status = await updatePortfolioNav(env, 'a', {
    adapter,
    ledgerRevision: 2,
    affectedFrom: '2026-07-30',
    now: () => Date.parse('2026-07-30T06:00:00.000Z'),
  });
  assert.equal(status.complete, true, JSON.stringify(status));
  assert.equal(status.priceBasis, 'cash_only');
  assert.equal(status.netValue, 1100);
  const childTape = await loadFrozenLedgerPriceTape(env, 'a', 2);
  assert.equal(childTape.parentPriceTapeId, parentTape.priceTapeId);
  const currentLedger = JSON.parse(env.YC_KV.values.get('ledger:a'));
  assert.equal(currentLedger.ledgerRevision, 2);
  assert.equal(currentLedger.positions.length, 0);
  assert.equal(currentLedger.cash, 1100);
  assert.equal(currentLedger.units, 1100);
  assert.equal(currentLedger.navRows.at(-1).valuation.priceBasis, 'cash_only');
  assert.equal(currentLedger.navRows.at(-1).valuation.sessionVerified, true);
});

test('ordinary live NAV fails closed instead of using lastPx or ledger book value', async () => {
  const env = await ledgerEnvironment();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 3 WHERE portfolio_id = 'a'`)
    .run();
  await persistLedgerValuation(env, 'a', {
    date: '2026-07-29', cash: 100, marketValue: 300, totalAssets: 400,
    liability: 0, netValue: 400, units: 100, unitNav: 4,
    sourceRef: 'daily:raw-close', valuation: { priceBasis: 'RAW_CLOSE' }, warnings: [],
  }, [
    {
      ticker: '600919.SS', date: '2026-07-29', close: 10,
      source: 'TUSHARE', sourceRef: 'daily:600919.SH',
    },
    {
      ticker: '000001.SZ', date: '2026-07-29', close: 20,
      source: 'TUSHARE', sourceRef: 'daily:000001.SZ',
    },
  ], 3);

  const ledgerRaw = JSON.stringify({
    market: 'a', portfolio: 'a', currency: 'CNY', ledgerRevision: 3,
    positions: [
      {
        t: '600919.SS', n: 'Bank A', q: 10,
        p: 777, mv: 100, pnl: 0, buyCost: 100,
      },
      {
        t: '000001.SZ', n: 'Bank B', q: 10,
        p: 888, mv: 200, pnl: 0, buyCost: 200,
      },
    ],
    cash: 100, liability: 0, units: 100,
    lastDate: '2026-07-29', lastUnitNav: 4, baseNetValue: 400,
    navRows: [{ date: '2026-07-29', unitNav: 4, netValue: 400 }],
    navRecalculationRequired: [], corporateActionPricePending: [],
  });
  const liveRaw = JSON.stringify({
    rows: [], marketDate: '2026-07-29', updatedAt: '2026-07-29T08:00:00.000Z',
    holdings: [
      { t: '600919.SS', q: 10, price: 10 },
      { t: '000001.SZ', q: 10, price: 20 },
    ],
  });
  const navcacheRaw = JSON.stringify({
    ok: true, snapshot_id: 'last-success', as_of: '2026-07-29',
    rows: [{ date: '2026-07-29', unitNav: 4 }],
  });
  const lastPxRaw = JSON.stringify({
    '600919.SS': { date: '2026-07-29', close: 777, source: 'persisted-lastpx' },
    '000001.SZ': { date: '2026-07-29', close: 888, source: 'persisted-lastpx' },
  });
  env.YC_KV.values.set('ledger:a', ledgerRaw);
  env.YC_KV.values.set('live:a', liveRaw);
  env.YC_KV.values.set('navcache:a', navcacheRaw);
  env.YC_KV.values.set('lastpx:a', lastPxRaw);
  env.YC_KV.puts = [];

  const navBefore = database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, net_value_minor
    FROM ledger_nav_snapshots WHERE portfolio_id = 'a' ORDER BY nav_date
  `).all().map(row => ({ ...row }));
  const pricesBefore = database.prepare(`
    SELECT ticker, price_date, price_micros
    FROM ledger_prices WHERE portfolio_id = 'a' ORDER BY price_date, ticker
  `).all().map(row => ({ ...row }));
  const calls = [];
  const adapter = {
    async query(dataset, request) {
      calls.push([dataset, request.params.ts_code]);
      if (dataset === 'trade_cal') {
        assert.equal(request.params.exchange, 'SSE');
        return officialCalendar(request, ['20260730']);
      }
      if (dataset === 'rt_k' && request.params.ts_code === '600919.SH') {
        return {
          data: [{
            ts_code: '600919.SH', close: 11,
            trade_time: '2026-07-30 13:59:00',
          }],
          freshness_class: 'intraday_snapshot',
          fetched_at: '2026-07-30T07:00:00.000Z',
        };
      }
      if (dataset === 'rt_k' && request.params.ts_code === '000001.SZ') {
        throw new Error('realtime unavailable');
      }
      if (dataset === 'daily' && request.params.ts_code === '000001.SZ') {
        return {
          data: [],
          freshness_class: 'eod',
          fetched_at: '2026-07-30T08:00:00.000Z',
        };
      }
      throw new Error(`unexpected quote request ${dataset}:${request.params.ts_code}`);
    },
  };

  const status = await updatePortfolioNav(env, 'a', {
    adapter,
    now: () => Date.parse('2026-07-30T06:00:00.000Z'),
  });
  assert.equal(status.skip, 'valuation-price-unavailable');
  assert.equal(status.reason, 'latest_tushare_request_failed');
  assert.equal(status.failure_code, 'active_holding_quote_unavailable');
  assert.equal(status.fallback, true);
  assert.deepEqual(status.unavailable, ['000001.SZ']);
  assert.deepEqual(calls, [
    ['trade_cal', undefined],
    ['rt_k', '600919.SH'],
    ['rt_k', '000001.SZ'],
    ['daily', '000001.SZ'],
  ]);

  const navAfter = database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, net_value_minor
    FROM ledger_nav_snapshots WHERE portfolio_id = 'a' ORDER BY nav_date
  `).all().map(row => ({ ...row }));
  const pricesAfter = database.prepare(`
    SELECT ticker, price_date, price_micros
    FROM ledger_prices WHERE portfolio_id = 'a' ORDER BY price_date, ticker
  `).all().map(row => ({ ...row }));
  assert.deepEqual(navAfter, navBefore);
  assert.deepEqual(pricesAfter, pricesBefore);
  assert.equal(env.YC_KV.values.get('ledger:a'), ledgerRaw);
  assert.equal(env.YC_KV.values.get('live:a'), liveRaw);
  assert.equal(env.YC_KV.values.get('navcache:a'), navcacheRaw);
  assert.equal(env.YC_KV.values.get('lastpx:a'), lastPxRaw);
  assert.deepEqual(env.YC_KV.puts.map(write => write.key), ['navstatus:a']);
});

test('ordinary live NAV fails closed when active holding quote dates are mixed', async () => {
  const ledgerRaw = JSON.stringify({
    market: 'a', portfolio: 'a', currency: 'CNY', ledgerRevision: 1,
    positions: [
      { t: '600919.SS', n: 'Bank A', q: 10, mv: 100, pnl: 0, buyCost: 100 },
      { t: '000001.SZ', n: 'Bank B', q: 10, mv: 200, pnl: 0, buyCost: 200 },
    ],
    cash: 100, liability: 0, units: 100,
    lastDate: '2026-07-29', lastUnitNav: 4, baseNetValue: 400,
    navRows: [{ date: '2026-07-29', unitNav: 4, netValue: 400 }],
    navRecalculationRequired: [], corporateActionPricePending: [],
  });
  const liveRaw = JSON.stringify({ rows: [], marketDate: '2026-07-29' });
  const navcacheRaw = JSON.stringify({
    ok: true, snapshot_id: 'last-success', as_of: '2026-07-29',
  });
  const lastPxRaw = JSON.stringify({
    '600919.SS': { date: '2026-07-29', close: 10 },
    '000001.SZ': { date: '2026-07-29', close: 20 },
  });
  const env = {
    YC_KV: new MemoryKv({
      'ledger:a': ledgerRaw,
      'live:a': liveRaw,
      'navcache:a': navcacheRaw,
      'lastpx:a': lastPxRaw,
    }),
  };
  const adapter = {
    async query(dataset, request) {
      if (dataset === 'trade_cal') return officialCalendar(request, ['20260730']);
      if (dataset === 'rt_k') {
        const current = request.params.ts_code === '600919.SH';
        return {
          data: [{
            ts_code: request.params.ts_code,
            close: current ? 11 : 21,
            trade_time: current ? '2026-07-30 13:59:00' : '2026-07-29 15:00:00',
          }],
          freshness_class: 'intraday_snapshot',
          fetched_at: '2026-07-30T07:00:00.000Z',
        };
      }
      if (dataset === 'daily') {
        return {
          data: [{
            ts_code: request.params.ts_code,
            trade_date: '20260729',
            close: 21,
          }],
          freshness_class: 'eod',
          fetched_at: '2026-07-30T07:00:00.000Z',
        };
      }
      assert.equal(dataset, 'index_daily');
      return {
        data: [{ ts_code: '000300.SH', trade_date: '20260730', close: 4000 }],
        freshness_class: 'eod',
        fetched_at: '2026-07-30T08:00:00.000Z',
      };
    },
  };

  const status = await updatePortfolioNav(env, 'a', {
    adapter,
    now: () => Date.parse('2026-07-30T06:00:00.000Z'),
  });
  assert.equal(status.skip, 'valuation-date-mismatch');
  assert.equal(status.reason, 'active_holding_quote_dates_mixed');
  assert.equal(status.failure_code, 'active_holding_quote_dates_mixed');
  assert.deepEqual(status.quote_dates, [
    { ticker: '600919.SS', date: '2026-07-30' },
    { ticker: '000001.SZ', date: '2026-07-29' },
  ]);
  assert.equal(env.YC_KV.values.get('ledger:a'), ledgerRaw);
  assert.equal(env.YC_KV.values.get('live:a'), liveRaw);
  assert.equal(env.YC_KV.values.get('navcache:a'), navcacheRaw);
  assert.equal(env.YC_KV.values.get('lastpx:a'), lastPxRaw);
  assert.deepEqual(env.YC_KV.puts.map(write => write.key), ['navstatus:a']);
});

test('A/HK past-session realtime never overwrites a prior-session NAV', async () => {
  for (const spec of [
    {
      portfolio: 'a', ticker: '600919.SS', requestTicker: '600919.SH',
      calendar: 'trade_cal', realtime: 'rt_k', eod: 'daily',
    },
    {
      portfolio: 'hk', ticker: '0700.HK', requestTicker: '00700.HK',
      calendar: 'hk_tradecal', realtime: 'rt_hk_k', eod: 'hk_daily',
    },
  ]) {
    const navcacheRaw = JSON.stringify({
      ok: true, snapshot_id: `prior-${spec.portfolio}`, as_of: '2026-07-31',
    });
    const env = { YC_KV: new MemoryKv({
      [`ledger:${spec.portfolio}`]: JSON.stringify({
        market: spec.portfolio, portfolio: spec.portfolio, ledgerRevision: 1,
        positions: [{ t: spec.ticker, q: 10, mv: 100, pnl: 0 }],
        cash: 0, liability: 0, units: 100,
        lastDate: '2026-07-31', lastUnitNav: 1, baseNetValue: 100,
        navRows: [{
          date: '2026-07-31', unitNav: 1, netValue: 100,
          valuation: { freshness_class: 'eod', priceBasis: 'raw_close' },
        }],
        navRecalculationRequired: [], corporateActionPricePending: [],
      }),
      [`navcache:${spec.portfolio}`]: navcacheRaw,
    }) };
    const datasets = [];
    const adapter = {
      async query(dataset, request) {
        datasets.push(dataset);
        if (dataset === spec.calendar) return officialCalendar(request, ['20260731']);
        if (dataset === spec.realtime) {
          return {
            data: [{
              ts_code: spec.requestTicker,
              close: 999,
              ...(spec.portfolio === 'a' ? { trade_time: '2026-07-31 15:00:00' } : {}),
            }],
            freshness_class: 'intraday_snapshot',
            fetched_at: '2026-08-01T04:00:00.000Z',
          };
        }
        assert.equal(dataset, spec.eod);
        return {
          data: [{ ts_code: spec.requestTicker, trade_date: '20260731', close: 10 }],
          freshness_class: 'eod',
          fetched_at: '2026-08-01T04:00:00.000Z',
        };
      },
    };
    const status = await updatePortfolioNav(env, spec.portfolio, {
      adapter,
      now: () => Date.parse('2026-08-01T04:00:00.000Z'),
    });
    assert.equal(status.fallback, true);
    assert.equal(status.pricing_fallback, 'latest_eod_snapshot');
    assert.equal(status.source_endpoint, spec.eod);
    assert.equal(env.YC_KV.values.get(`navcache:${spec.portfolio}`), navcacheRaw);
    assert.deepEqual(datasets, [spec.calendar, spec.realtime, spec.eod]);
  }
});

test('US intraday Yahoo failure fails closed without using yesterday Tushare EOD', async () => {
  const ledgerRaw = JSON.stringify({
    market: 'us', portfolio: 'us', currency: 'USD', ledgerRevision: 1,
    positions: [{ t: 'AAA.US', n: 'AAA', q: 10, p: 999, mv: 100, pnl: 0 }],
    cash: 100, liability: 0, units: 100,
    lastDate: '2026-07-29', lastUnitNav: 2, baseNetValue: 200,
    navRows: [{ date: '2026-07-29', unitNav: 2, netValue: 200 }],
    navRecalculationRequired: [], corporateActionPricePending: [],
  });
  const liveRaw = JSON.stringify({ rows: [], marketDate: '2026-07-29' });
  const navcacheRaw = JSON.stringify({ ok: true, snapshot_id: 'last-success' });
  const lastPxRaw = JSON.stringify({
    'AAA.US': { date: '2026-07-29', close: 999, source: 'persisted-lastpx' },
  });
  const env = { YC_KV: new MemoryKv({
    'ledger:us': ledgerRaw,
    'live:us': liveRaw,
    'navcache:us': navcacheRaw,
    'lastpx:us': lastPxRaw,
  }) };
  const datasets = [];
  const adapter = {
    async query(dataset, request) {
      datasets.push(dataset);
      if (dataset === 'us_tradecal') return officialCalendar(request, ['20260730']);
      throw new Error('yesterday EOD must not be requested during the current session');
    },
  };
  let yahooCalls = 0;
  const status = await updatePortfolioNav(env, 'us', {
    adapter,
    now: () => Date.parse('2026-07-30T19:00:00.000Z'), // 15:00 New York.
    fetch: async () => {
      yahooCalls += 1;
      throw new Error('Yahoo unavailable');
    },
  });
  assert.equal(status.skip, 'valuation-price-unavailable');
  assert.equal(status.failure_code, 'active_holding_quote_unavailable');
  assert.deepEqual(datasets, ['us_tradecal']);
  assert.equal(yahooCalls, 1);
  assert.equal(env.YC_KV.values.get('ledger:us'), ledgerRaw);
  assert.equal(env.YC_KV.values.get('live:us'), liveRaw);
  assert.equal(env.YC_KV.values.get('navcache:us'), navcacheRaw);
  assert.equal(env.YC_KV.values.get('lastpx:us'), lastPxRaw);
});

test('US weekend uses verified-session raw EOD and never stale Yahoo realtime', async () => {
  const env = { YC_KV: new MemoryKv({
    'ledger:us': JSON.stringify({
      market: 'us', portfolio: 'us', currency: 'USD', ledgerRevision: 1,
      positions: [{ t: 'AAA.US', n: 'AAA', q: 10, mv: 100, pnl: 0 }],
      cash: 0, liability: 0, units: 100,
      lastDate: '2026-07-31', lastUnitNav: 1, baseNetValue: 100,
      navRows: [{
        date: '2026-07-31', unitNav: 1, netValue: 100,
        valuation: { freshness_class: 'eod', priceBasis: 'raw_close' },
      }],
      navRecalculationRequired: [], corporateActionPricePending: [],
    }),
  }) };
  const datasets = [];
  const adapter = {
    async query(dataset, request) {
      datasets.push(dataset);
      if (dataset === 'us_tradecal') return officialCalendar(request, ['20260731']);
      assert.equal(dataset, 'us_daily');
      return {
        data: [{ ts_code: 'AAA', trade_date: '20260731', close: 10 }],
        freshness_class: 'eod',
        fetched_at: '2026-08-01T16:00:00.000Z',
      };
    },
  };
  let yahooCalls = 0;
  const status = await updatePortfolioNav(env, 'us', {
    adapter,
    now: () => Date.parse('2026-08-01T16:00:00.000Z'),
    fetch: async () => {
      yahooCalls += 1;
      throw new Error('Yahoo must not be called outside the current session');
    },
  });
  assert.equal(status.fallback, true);
  assert.equal(status.pricing_fallback, 'latest_eod_snapshot');
  assert.equal(status.reason, 'latest_realtime_unavailable_eod_not_newer');
  assert.deepEqual(datasets, ['us_tradecal', 'us_daily']);
  assert.equal(yahooCalls, 0);
});

test('US premarket fails closed when only the previous-session EOD exists', async () => {
  const env = { YC_KV: new MemoryKv({
    'ledger:us': JSON.stringify({
      market: 'us', portfolio: 'us', ledgerRevision: 1,
      positions: [{ t: 'AAA.US', q: 10, mv: 100, pnl: 0 }],
      cash: 0, liability: 0, units: 100,
      lastDate: '2026-07-29', lastUnitNav: 1, baseNetValue: 100,
      navRows: [{ date: '2026-07-29', unitNav: 1, netValue: 100 }],
      navRecalculationRequired: [], corporateActionPricePending: [],
    }),
  }) };
  const datasets = [];
  const adapter = {
    async query(dataset, request) {
      datasets.push(dataset);
      if (dataset === 'us_tradecal') return officialCalendar(request, ['20260730']);
      assert.equal(dataset, 'us_daily');
      return {
        data: [{ ts_code: 'AAA', trade_date: '20260729', close: 10 }],
        freshness_class: 'eod',
      };
    },
  };
  let yahooCalls = 0;
  const status = await updatePortfolioNav(env, 'us', {
    adapter,
    now: () => Date.parse('2026-07-30T12:00:00.000Z'), // 08:00 New York.
    fetch: async () => {
      yahooCalls += 1;
      throw new Error('premarket must not use Yahoo last trade as current counter');
    },
  });
  assert.equal(status.skip, 'valuation-price-unavailable');
  assert.deepEqual(datasets, ['us_tradecal', 'us_daily']);
  assert.equal(yahooCalls, 0);
});

test('live market value sums exact fractional quantity-price products before rounding', async () => {
  const env = await ledgerEnvironment();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`UPDATE ledger_portfolios SET ledger_revision = 3 WHERE portfolio_id = 'us'`)
    .run();
  insertConfirmedEvent(database, {
    portfolio: 'us', currency: 'USD', eventId: 'fractional-capital', revision: 1,
    eventType: 'CAPITAL', date: '2026-07-29', sequence: 1,
    payload: {
      shareholder: 'LP1', subscription: '1.00', redemption: '0', unit_price: '1.00',
    },
  });
  for (const [index, ticker] of ['AAA.US', 'BBB.US'].entries()) {
    insertConfirmedEvent(database, {
      portfolio: 'us', currency: 'USD', eventId: `fractional-buy-${index + 1}`,
      revision: index + 2, eventType: 'BUY', date: '2026-07-29', sequence: index + 1,
      payload: {
        ticker, name: ticker, quantity: 0.006,
        gross_amount: '0.01', tax_amount: '0', fee_amount: '0', net_cash: '-0.01',
      },
    });
  }
  await persistLedgerValuation(env, 'us', {
    date: '2026-07-29', cash: 0.98, marketValue: 0.01, totalAssets: 0.99,
    liability: 0, netValue: 0.99, units: 1, unitNav: 0.99,
    sourceRef: 'us_daily:raw-close', valuation: { priceBasis: 'RAW_CLOSE' }, warnings: [],
  }, ['AAA.US', 'BBB.US'].map(ticker => ({
    ticker, date: '2026-07-29', close: 0.5,
    source: 'TUSHARE', sourceRef: `us_daily:${ticker}`,
  })), 3);
  await freezeTape(env, 'us', 3, {
    from: '2026-07-29',
    prices: ['AAA.US', 'BBB.US'].map(ticker => ({
      ticker, date: '2026-07-29', close: 0.5,
    })),
  });
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 3 });

  const adapter = {
    async query(dataset, request) {
      if (dataset === 'us_tradecal') {
        return officialCalendar(request, ['20260730']);
      }
      assert.equal(dataset, 'us_daily');
      return {
        data: [{
          ts_code: request.params.ts_code,
          trade_date: '20260730',
          close: request.params.ts_code === 'SPY' ? 600 : 1,
        }],
        freshness_class: 'eod',
        fetched_at: '2026-07-30T21:00:00.000Z',
      };
    },
  };
  let yahooPrice = 1;
  const yahooFetch = async url => {
    assert.match(String(url), /query2\.finance\.yahoo\.com\/v8\/finance\/chart\/(AAA|BBB)/);
    return {
      ok: true,
      async json() {
        return {
          chart: { result: [{ meta: {
            regularMarketPrice: yahooPrice,
            regularMarketTime: Date.parse('2026-07-30T18:59:00.000Z') / 1000,
            marketState: 'REGULAR',
          } }] },
        };
      },
    };
  };
  const status = await updatePortfolioNav(env, 'us', {
    adapter,
    now: () => Date.parse('2026-07-30T19:00:00.000Z'),
    fetch: yahooFetch,
  });
  assert.equal(status.appended, '2026-07-30');
  assert.equal(status.marketValue, 0.01);
  assert.equal(status.netValue, 0.99);

  const nav = database.prepare(`
    SELECT cash_minor, market_value_minor, total_assets_minor, net_value_minor,
      units_micros, unit_nav_micros
    FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' AND nav_date = '2026-07-30'
  `).get();
  assert.deepEqual({ ...nav }, {
    cash_minor: 98,
    market_value_minor: 1,
    total_assets_minor: 99,
    net_value_minor: 99,
    units_micros: 1_000_000,
    unit_nav_micros: 992_000,
  });
  const publicNav = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.deepEqual(publicNav.navRows.at(-1), {
    date: '2026-07-30', nav: 0.992, ret: 0.002020202,
    unitNav: 0.992, units: 1, marketValue: 0.01, cash: 0.98,
    liability: 0, totalAssets: 0.99, netValue: 0.99,
    mv: 0.99, divPerUnit: 0,
  });
  assert.deepEqual(publicNav.base, {
    date: '2026-07-30', unitNav: 0.992, marketValue: 0.01,
    totalAssets: 0.99, netValue: 0.99, cash: 0.98, liability: 0, units: 1,
  });
  const live = JSON.parse(env.YC_KV.values.get('live:us'));
  assert.deepEqual(live.holdings.map(row => row.marketValue), [0.01, 0.01]);
  assert.deepEqual(live.holdings.map(row => row.weight), [50, 50]);
  assert.equal(live.holdings[0].quoteSource, 'yahoo:query2-chart');
  assert.equal(live.holdings[0].priceBasis, 'raw_counter');

  yahooPrice = 2;
  const refreshed = await updatePortfolioNav(env, 'us', {
    adapter,
    now: () => Date.parse('2026-07-30T19:00:00.000Z'),
    fetch: yahooFetch,
  });
  assert.equal(refreshed.appended, '2026-07-30');
  assert.equal(refreshed.marketValue, 0.02);
  assert.equal(refreshed.netValue, 1);
  assert.equal(refreshed.source, 'yahoo:query2-chart');
  const refreshedNav = database.prepare(`
    SELECT market_value_minor, net_value_minor, unit_nav_micros, source
    FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' AND nav_date = '2026-07-30'
  `).get();
  assert.deepEqual({ ...refreshedNav }, {
    market_value_minor: 2,
    net_value_minor: 100,
    unit_nav_micros: 1_004_000,
    source: 'yahoo:query2-chart',
  });
  const refreshedPublicNav = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.deepEqual(refreshedPublicNav.navRows.at(-1), {
    date: '2026-07-30', nav: 1.004, ret: 0.0141414141,
    unitNav: 1.004, units: 1, marketValue: 0.02, cash: 0.98,
    liability: 0, totalAssets: 1, netValue: 1,
    mv: 1, divPerUnit: 0,
  });

  const priorKv = Object.fromEntries(
    ['ledger:us', 'live:us', 'lastpx:us', 'navstatus:us', 'navcache:us']
      .map(key => [key, env.YC_KV.values.get(key)]),
  );
  const originalPut = env.YC_KV.put.bind(env.YC_KV);
  let revisionAdvanced = false;
  env.YC_KV.put = async (key, value) => {
    await originalPut(key, value);
    if (key === 'navcache:us' && !revisionAdvanced) {
      revisionAdvanced = true;
      database.prepare(`
        UPDATE ledger_portfolios SET ledger_revision = 4 WHERE portfolio_id = 'us'
      `).run();
    }
  };
  yahooPrice = 3;
  await assert.rejects(
    updatePortfolioNav(env, 'us', {
      adapter,
      now: () => Date.parse('2026-07-30T19:00:00.000Z'),
      fetch: yahooFetch,
    }),
    error => error && error.details && error.details.code === 'LEDGER_REVISION_CHANGED',
  );
  assert.equal(revisionAdvanced, true);
  for (const [key, value] of Object.entries(priorKv)) {
    assert.equal(env.YC_KV.values.get(key), value, key);
  }
});

test('A 2025-01-06 NAV uses raw counter closes and rejects the old adjusted-price result', async () => {
  const env = await ledgerEnvironment();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 7 WHERE portfolio_id = 'a'
  `).run();

  const events = [
    {
      event_id: 'capital-1', type: 'CAPITAL', date: '2025-01-06', sequence: 1,
      shareholder: 'Yi', subscription: 500000, redemption: 0, unit_price: 0.1,
    },
    {
      event_id: 'capital-2', type: 'CAPITAL', date: '2025-01-06', sequence: 2,
      shareholder: 'Yi', subscription: 0, redemption: 35318, unit_price: 0.095437912,
    },
    ...[
      ['600919.SS', 10000, 96300],
      ['601838.SS', 3700, 60902],
      ['601318.SS', 2000, 100680],
      ['600036.SS', 1500, 58020],
      ['000001.SZ', 10000, 113900],
    ].map(([ticker, quantity, amount], index) => ({
      event_id: `buy-${index + 1}`,
      type: 'BUY',
      date: '2025-01-06',
      sequence: index + 1,
      ticker,
      quantity,
      amount,
      net_cash: -amount,
      tax_status: 'UNKNOWN_LEGACY',
    })),
  ];
  const rawCloses = new Map([
    ['600919.SH', { raw: 9.64, adjusted: 8.70920181274414 }],
    ['601838.SH', { raw: 16.56, adjusted: 15.036548614501953 }],
    ['601318.SH', { raw: 50.34, adjusted: 46.55603790283203 }],
    ['600036.SH', { raw: 39.05, adjusted: 35.51110076904297 }],
    ['000001.SZ', { raw: 11.44, adjusted: 10.518184661865234 }],
  ]);
  const adapter = {
    async query(dataset, request) {
      if (dataset === 'trade_cal') {
        assert.equal(request.params.exchange, 'SSE');
        assert.equal(request.params.start_date, '20250106');
        assert.equal(request.params.end_date, '20250106');
        return {
          data: [{ cal_date: '20250106', is_open: 1 }],
          freshness_class: 'static',
          fetched_at: '2025-01-06T08:00:00.000Z',
        };
      }
      if (dataset === 'daily') {
        const prices = rawCloses.get(request.params.ts_code);
        assert.ok(prices, request.params.ts_code);
        return {
          data: [{
            ts_code: request.params.ts_code,
            trade_date: '20250106',
            close: prices.raw,
            adjusted_close: prices.adjusted,
          }],
          freshness_class: 'eod',
          fetched_at: '2025-01-06T08:00:00.000Z',
        };
      }
      assert.equal(dataset, 'index_daily');
      assert.equal(request.params.ts_code, '000300.SH');
      return {
        data: [{ ts_code: '000300.SH', trade_date: '20250106', close: 3768 }],
        freshness_class: 'eod',
        fetched_at: '2025-01-06T08:00:00.000Z',
      };
    },
  };

  const status = await rebuildPortfolioNavHistory(env, 'a', {
    market: 'a', portfolio: 'a', ledgerRevision: 7,
    confirmedEvents: events, navRows: [],
  }, {
    adapter,
    now: () => Date.parse('2025-01-06T08:00:00.000Z'),
    affectedFrom: '2025-01-06',
    ledgerRevision: 7,
    batchSize: 50,
  });
  assert.equal(status.batchFrom, '2025-01-06');
  assert.equal(status.batchThrough, '2025-01-06');

  const nav = env.FEEDBACK_DB.database.prepare(`
    SELECT cash_minor, market_value_minor, total_assets_minor, liability_minor,
      net_value_minor, units_micros, unit_nav_micros
    FROM ledger_nav_snapshots WHERE portfolio_id = 'a' AND nav_date = '2025-01-06'
  `).get();
  assert.deepEqual({ ...nav }, {
    cash_minor: 3_488_000,
    market_value_minor: 43_132_700,
    total_assets_minor: 46_620_700,
    liability_minor: 0,
    net_value_minor: 46_620_700,
    units_micros: 4_629_937_419_419,
    unit_nav_micros: 100_694,
  });

  const exactUnits = 500000 / 0.1 - 35318 / 0.095437912;
  const exactRawUnitNav = 466207 / exactUnits;
  assert.ok(Math.abs(exactRawUnitNav - 0.1006940176) < 1e-10);
  assert.notEqual(nav.market_value_minor, 39_428_782);
  assert.notEqual(nav.net_value_minor, 42_916_782);

  const tape = env.FEEDBACK_DB.database.prepare(`
    SELECT price_tape_id, price_basis, adjusted, price_row_count
    FROM ledger_price_tapes
    WHERE portfolio_id = 'a' AND ledger_revision = 7
  `).get();
  assert.equal(tape.price_tape_id, status.priceTapeId);
  assert.equal(tape.price_basis, 'raw_close');
  assert.equal(tape.adjusted, 0);
  assert.equal(tape.price_row_count, 5);
  const storedPrices = env.FEEDBACK_DB.database.prepare(`
    SELECT r.ticker, r.price_micros
    FROM ledger_price_tape_rows r
    JOIN ledger_price_tapes t ON t.price_tape_id = r.price_tape_id
    WHERE t.portfolio_id = 'a' AND t.ledger_revision = 7
      AND r.price_date = '2025-01-06'
    ORDER BY r.ticker
  `).all().map(row => [row.ticker, row.price_micros]);
  assert.deepEqual(storedPrices, [
    ['000001.SZ', 11_440_000],
    ['600036.SS', 39_050_000],
    ['600919.SS', 9_640_000],
    ['601318.SS', 50_340_000],
    ['601838.SS', 16_560_000],
  ]);
});
