import assert from 'node:assert/strict';
import test from 'node:test';

import { detectDividendCandidates } from '../worker/dividend-detector.js';

const NOW = Date.parse('2026-07-01T04:00:00.000Z');

function unix(value) {
  return Math.floor(Date.parse(value) / 1000);
}

function yahooResponse({ dividends = {}, splits = {} } = {}) {
  return {
    ok: true,
    async json() {
      return {
        chart: {
          error: null,
          result: [{ events: { dividends, splits } }],
        },
      };
    },
  };
}

test('Yahoo keeps two splits in one month as independent candidates and filters every event by holding periods', async () => {
  const calls = [];
  const firstSplit = unix('2026-06-05T13:30:00.000Z');
  const outsideHolding = unix('2026-06-15T13:30:00.000Z');
  const secondSplit = unix('2026-06-25T13:30:00.000Z');
  const heldDividend = unix('2026-06-06T13:30:00.000Z');
  const unheldDividend = unix('2026-06-16T13:30:00.000Z');

  const run = await detectDividendCandidates({
    holdings: [{
      portfolio: 'us',
      ticker: 'XYZ',
      name: 'XYZ Holdings',
      holding_periods: [
        { fromDate: '2026-06-01', throughDate: '2026-06-10', quantity: 10 },
        { fromDate: '2026-06-20', throughDate: '2026-06-30', quantity: 20 },
      ],
    }],
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    includeCorporateActions: true,
    now: () => NOW,
    fetchImpl: async url => {
      calls.push(String(url));
      return yahooResponse({
        dividends: {
          held_dividend: { date: heldDividend, amount: 1000 },
          unheld_dividend: { date: unheldDividend, amount: 1000 },
        },
        splits: {
          first_split: {
            date: firstSplit, numerator: 2, denominator: 1, splitRatio: '2:1',
          },
          outside_holding_split: {
            date: outsideHolding, numerator: 5, denominator: 1, splitRatio: '5:1',
          },
          second_split: {
            date: secondSplit, numerator: 3, denominator: 2, splitRatio: '3:2',
          },
        },
      });
    },
  });

  assert.equal(run.is_complete, true);
  assert.equal(run.checked_holdings, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /events=div%2Csplits/);
  assert.match(calls[0], /includeAdjustedClose=false/);

  const dividends = run.candidates.filter(item => item.event_type === 'DIVIDEND');
  const actions = run.candidates.filter(item => item.event_type === 'CORPORATE_ACTION');
  assert.equal(dividends.length, 1, 'a dividend while no shares were held must not enter review');
  assert.equal(dividends[0].ex_date, '2026-06-06');
  assert.equal(actions.length, 2, 'two provider split events in one month must stay separate');
  assert.deepEqual(actions.map(item => item.action_date), ['2026-06-05', '2026-06-25']);
  assert.deepEqual(actions.map(item => item.source_event_id), [
    `yahoo:query2-chart:XYZ:split:${firstSplit}`,
    `yahoo:query2-chart:XYZ:split:${secondSplit}`,
  ]);
  assert.equal(new Set(actions.map(item => item.dedupe_key)).size, 2);
  assert.deepEqual(actions.map(item => item.evidence.provider_event_key), [
    'first_split', 'second_split',
  ]);
  assert.deepEqual(actions.map(item => item.evidence.split_ratio), [2, 1.5]);
  assert.ok(actions.every(item => item.cash_change === null));
  assert.doesNotMatch(JSON.stringify(run.candidates), /1000/,
    'provider money is only a presence signal and must not be copied into a candidate');
});

test('Tushare stock-distribution total is not double counted and name changes stay separate', async () => {
  const calls = [];
  const run = await detectDividendCandidates({
    holdings: [{
      portfolio: 'a', ticker: '600000.SH', name: '浦發銀行',
      holding_periods: [{ fromDate: '2025-01-01', throughDate: '2026-06-30', quantity: 100 }],
    }],
    fromDate: '2026-06-01',
    toDate: '2026-06-30',
    includeCorporateActions: true,
    now: () => NOW,
    tushareAdapter: {
      async query(endpoint) {
        calls.push(endpoint);
        if (endpoint === 'dividend') {
          return {
            is_complete: true,
            source_doc_url: 'https://tushare.pro/document/2?doc_id=103',
            data: [{
              ts_code: '600000.SH', end_date: '20251231', ann_date: '20260601',
              div_proc: '实施', cash_div: 0, stk_div: 0.1,
              stk_bo_rate: 0.1, stk_co_rate: 0,
              record_date: '20260609', ex_date: '20260610', pay_date: null,
              imp_ann_date: '20260601',
            }],
          };
        }
        assert.equal(endpoint, 'namechange');
        return {
          is_complete: true,
          source_doc_url: 'https://tushare.pro/document/2?doc_id=100',
          data: [{
            ts_code: '600000.SH', name: '浦發新名', start_date: '20260620',
            end_date: null, ann_date: '20260619', change_reason: '改名',
          }],
        };
      },
    },
  });

  assert.deepEqual(calls, ['dividend', 'namechange']);
  assert.equal(run.is_complete, true);
  const actions = run.candidates.filter(item => item.event_type === 'CORPORATE_ACTION');
  assert.equal(actions.length, 2);
  const distribution = actions.find(item => item.action_type_hint === 'SPLIT');
  const rename = actions.find(item => item.action_type_hint === 'RENAME');
  assert.equal(distribution.evidence.stock_distribution_ratio, 0.1,
    'stk_div is already the total and must not be added to its component again');
  assert.equal(rename.action_date, '2026-06-20');
  assert.equal(rename.evidence.source_doc_url,
    'https://tushare.pro/document/2?doc_id=100');
});

test('Yahoo 404 for a historical delisted holding is skipped without blocking the scan', async () => {
  let calls = 0;
  const run = await detectDividendCandidates({
    holdings: [{
      portfolio: 'us', ticker: 'OLD', name: 'Delisted Co',
      holding_periods: [{ fromDate: '2020-01-01', throughDate: '2020-06-30', quantity: 10 }],
    }],
    fromDate: '2020-01-01',
    toDate: '2020-06-30',
    includeCorporateActions: true,
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 404,
        async json() { return {}; },
      };
    },
  });

  assert.equal(calls, 2, 'the bounded provider retry remains in place');
  assert.equal(run.is_complete, true,
    'a confirmed missing/delisted symbol must not keep the full-history scan PARTIAL forever');
  assert.equal(run.failed_holdings, 0);
  assert.equal(run.skipped_holdings, 1);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.skipped, [{
    portfolio: 'us', ticker: 'OLD', code: 'YAHOO_SYMBOL_NOT_FOUND',
  }]);
  assert.deepEqual(run.candidates, []);
});
