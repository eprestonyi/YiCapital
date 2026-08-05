import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectDividendCandidates,
  DIVIDEND_AMOUNT_STATUS,
  normalizeDividendHoldings,
} from '../worker/dividend-detector.js';
import {
  handleTushareTerminalRequest,
  TUSHARE_ENDPOINTS,
} from '../worker/tushare.js';

const NOW = Date.parse('2026-08-05T04:00:00.000Z');

function yahooResponse(events) {
  return {
    ok: true,
    async json() {
      return {
        chart: {
          error: null,
          result: [{ events: { dividends: events } }],
        },
      };
    },
  };
}

function unix(value) {
  return Math.floor(Date.parse(value) / 1000);
}

test('Tushare dividend is a controlled official endpoint', () => {
  assert.deepEqual(TUSHARE_ENDPOINTS.dividend.params, [
    'ts_code', 'ann_date', 'record_date', 'ex_date', 'imp_ann_date',
  ]);
  assert.equal(TUSHARE_ENDPOINTS.dividend.freshness_class, 'disclosure');
  assert.equal(
    TUSHARE_ENDPOINTS.dividend.source_doc_url,
    'https://tushare.pro/document/2?doc_id=103',
  );
});

test('the controlled dividend endpoint is not exposed by the browser market route', async () => {
  let fetchCalls = 0;
  const response = await handleTushareTerminalRequest(
    new Request('https://terminal.test/api/terminal/market?domain=Stocks&dataset=dividend&ts_code=600519.SH'),
    { TUSHARE_TOKEN: 'server-only-token' },
    {
      now: () => NOW,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('must not fetch');
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'ENDPOINT_NOT_ALLOWED');
  assert.equal(fetchCalls, 0);
});

test('A-share detection emits one review candidate and never imports an amount', async () => {
  const calls = [];
  const tushareAdapter = {
    async query(dataset, request) {
      calls.push({ dataset, request });
      return {
        source_doc_url: 'https://tushare.pro/document/2?doc_id=103',
        fetched_at: '2026-08-05T03:59:00.000Z',
        data: [
          {
            ts_code: '600519.SH', end_date: '20251231', ann_date: '20260330',
            div_proc: '实施', cash_div: 12.34, record_date: '20260802',
            ex_date: '20260803', pay_date: '20260803', imp_ann_date: '20260725',
            cash_div_tax: 99,
          },
          {
            ts_code: '600519.SH', end_date: '20251231', ann_date: '20260330',
            div_proc: '实施', cash_div: 12.34, record_date: '20260802',
            ex_date: '20260803', pay_date: '20260803', imp_ann_date: '20260725',
          },
          {
            ts_code: '600519.SH', end_date: '20261231', ann_date: '20270330',
            div_proc: '预案', cash_div: 10, ex_date: '20260804', pay_date: '20260804',
          },
          {
            ts_code: '600519.SH', end_date: '20241231', ann_date: '20250330',
            div_proc: '实施', cash_div: 10, ex_date: '20250804', pay_date: '20250804',
          },
        ],
      };
    },
  };

  const run = await detectDividendCandidates({
    holdings: [
      { portfolio: 'a', ticker: '600519', name: '贵州茅台', quantity: 10 },
      { portfolio: 'a', ticker: '600519.SH', name: '贵州茅台', q: 10 },
      { portfolio: 'a', ticker: '000001.SZ', name: '平安银行', quantity: 0 },
    ],
    fromDate: '2026-08-01',
    toDate: '2026-08-05',
    tushareAdapter,
    fetchImpl: null,
    now: () => NOW,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].dataset, 'dividend');
  assert.equal(calls[0].request.params.ts_code, '600519.SH');
  assert.match(calls[0].request.fields, /cash_div/);
  assert.doesNotMatch(calls[0].request.fields, /cash_div_tax/);
  assert.equal(run.checked_holdings, 1);
  assert.equal(run.is_complete, true);
  assert.equal(run.candidates.length, 1);
  assert.deepEqual(run.candidates[0], {
    schema_version: 'dividend-candidate-v1',
    event_type: 'DIVIDEND',
    candidate_status: 'PENDING',
    portfolio: 'a',
    ticker: '600519.SH',
    name: '贵州茅台',
    ex_date: '2026-08-03',
    pay_date: '2026-08-03',
    source_event_id: 'tushare:dividend:600519.SH:20251231:20260803:20260330',
    amount: null,
    amount_status: DIVIDEND_AMOUNT_STATUS,
    action_required: 'VERIFY_AND_ENTER_AMOUNT',
    dedupe_key: 'a|600519.SH|tushare:dividend:600519.SH:20251231:20260803:20260330',
    evidence: {
      provider: 'Tushare Pro',
      source: 'tushare:dividend',
      source_endpoint: 'dividend',
      source_doc_url: 'https://tushare.pro/document/2?doc_id=103',
      fetched_at: '2026-08-05T03:59:00.000Z',
      announcement_date: '2026-03-30',
      record_date: '2026-08-02',
      implementation_announcement_date: '2026-07-25',
      implementation_status: '实施',
      cash_distribution_signal: true,
    },
  });
  const serialized = JSON.stringify(run.candidates[0]);
  assert.doesNotMatch(serialized, /12\.34|cash_div|cash_div_tax|gross_amount|net_cash/i);
});

test('Yahoo chart dividend events cover US and HK holdings with stable dedupe IDs', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('BRK-B')) {
      const timestamp = unix('2026-08-03T13:30:00.000Z');
      return yahooResponse({
        first: { date: timestamp, amount: 1.25 },
        duplicate_provider_key: { date: timestamp, amount: 1.25 },
      });
    }
    if (url.includes('0700.HK')) {
      return yahooResponse({
        hk_event: { date: unix('2026-08-04T00:00:00.000Z'), amount: 2.5 },
      });
    }
    return yahooResponse({});
  };

  const run = await detectDividendCandidates({
    holdings: {
      us: [{ t: 'BRK.B', n: 'Berkshire Hathaway', q: 1 }],
      hk: [{ ticker: '00700.HK', name: '腾讯控股', quantity: 100 }],
    },
    fromDate: '2026-08-01',
    toDate: '2026-08-05',
    fetchImpl,
    now: () => NOW,
  });

  assert.equal(run.is_complete, true);
  assert.equal(run.candidates.length, 2);
  assert.ok(calls.some(url => url.includes('/BRK-B?')));
  assert.ok(calls.some(url => url.includes('/0700.HK?')));
  const us = run.candidates.find(candidate => candidate.portfolio === 'us');
  const hk = run.candidates.find(candidate => candidate.portfolio === 'hk');
  assert.equal(us.ticker, 'BRK.B');
  assert.equal(us.name, 'Berkshire Hathaway');
  assert.equal(us.ex_date, '2026-08-03');
  assert.equal(us.pay_date, null);
  assert.equal(us.source_event_id, `yahoo:query2-chart:BRK-B:dividend:${unix('2026-08-03T13:30:00.000Z')}`);
  assert.equal(hk.ticker, '00700.HK');
  assert.equal(hk.name, '腾讯控股');
  assert.equal(hk.ex_date, '2026-08-04');
  for (const candidate of run.candidates) {
    assert.equal(candidate.amount, null);
    assert.equal(candidate.amount_status, 'PENDING_VERIFICATION');
    assert.equal(candidate.candidate_status, 'PENDING');
    assert.equal(candidate.evidence.event_date_semantics, 'ex_date');
    assert.doesNotMatch(JSON.stringify(candidate), /1\.25|2\.5|gross_amount|net_cash|withholding|tax|fee/i);
  }
});

test('provider failures are explicit and do not block successful candidates', async () => {
  const fetchImpl = async url => {
    if (url.includes('/FAIL?')) return { ok: false };
    return yahooResponse({
      dividend: { date: unix('2026-08-03T13:30:00.000Z'), amount: 1 },
    });
  };
  const run = await detectDividendCandidates({
    holdings: [
      { portfolio: 'us', ticker: 'GOOD', quantity: 1 },
      { portfolio: 'us', ticker: 'FAIL', quantity: 1 },
    ],
    fromDate: '2026-08-01',
    toDate: '2026-08-05',
    fetchImpl,
    now: () => NOW,
  });

  assert.equal(run.is_complete, false);
  assert.equal(run.checked_holdings, 2);
  assert.equal(run.failed_holdings, 1);
  assert.equal(run.candidates.length, 1);
  assert.equal(run.candidates[0].ticker, 'GOOD');
  assert.deepEqual(run.errors, [{
    portfolio: 'us',
    ticker: 'FAIL',
    code: 'YAHOO_DIVIDEND_HTTP_UNAVAILABLE',
  }]);
});

test('holding normalization keeps only current positive positions', () => {
  assert.deepEqual(normalizeDividendHoldings([
    { portfolio: 'a', ticker: '000001', name: '平安银行', quantity: 1 },
    { portfolio: 'hk', ticker: '700.HK', name: '腾讯控股', quantity: -1 },
    { portfolio: 'us', ticker: 'AAPL.US', name: 'Apple', quantity: 0 },
    { portfolio: 'us', ticker: 'MSFT', name: 'Microsoft' },
  ]), [
    { portfolio: 'a', ticker: '000001.SZ', name: '平安银行' },
    { portfolio: 'us', ticker: 'MSFT', name: 'Microsoft' },
  ]);
});
