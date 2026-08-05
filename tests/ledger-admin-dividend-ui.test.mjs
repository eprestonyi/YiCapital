import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const [SOURCE, HTML] = await Promise.all([
  read('assets/yc-ledger-admin.js'),
  read('admin-ledger.html'),
]);

function testApi() {
  const window = {
    YC_LEDGER_TEST_MODE: true,
    YCAdmin: { api: async () => ({}), $: () => null, gate: () => {} },
  };
  vm.runInNewContext(SOURCE, {
    window,
    console,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    String,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    structuredClone,
    setTimeout,
    clearTimeout,
    document: {},
  }, { filename: 'yc-ledger-admin.js' });
  return window.YCLedgerWorkbookTest;
}

test('dividend inbox is visible above Pending and explains the cash boundary', () => {
  const inbox = HTML.indexOf('id="dividend-inbox-list"');
  const pending = HTML.indexOf('id="pending-list"');
  assert.ok(inbox >= 0 && pending > inbox, 'dividend inbox must render before Pending');
  assert.match(HTML, /Amount 必須填寫券商最終實際到賬金額，已包含所有預扣稅與費用/);
  assert.match(HTML, /只會建立 Automation Pending，仍須在下方另行 Confirm/);
  assert.match(SOURCE, /\/api\/admin\/ledger\/dividends\?portfolio=/);
  assert.match(SOURCE, /loadDividendCandidates\(\)/);
});

test('candidate normalization prefers server current quantity and preserves evidence', () => {
  const candidate = testApi().normalizeDividendCandidate({
    candidateId: 'ldc_1',
    portfolio: 'us',
    version: 3,
    status: 'PENDING_VERIFICATION',
    ticker: 'aaa',
    name: 'AAA Inc',
    exDate: '2026-08-01',
    recordDate: '2026-07-31',
    payDate: '2026-08-05',
    currentQuantity: 12.5,
    suggestedQuantity: 12.5,
    sourceSystem: 'YAHOO',
    sourceEventId: 'event-1',
    evidence: { provider: 'Yahoo Finance', source_url: 'https://example.test/evidence' },
  });

  assert.equal(candidate.candidateId, 'ldc_1');
  assert.equal(candidate.ticker, 'AAA');
  assert.equal(candidate.currentQuantity, 12.5);
  assert.equal(candidate.suggestedQuantity, 12.5);
  assert.equal(candidate.evidence.provider, 'Yahoo Finance');
});

test('verify sends one broker Amount into Automation Pending without auto-confirm', () => {
  const api = testApi();
  const candidate = api.normalizeDividendCandidate({
    candidateId: 'ldc_2', version: 4, ticker: 'AAA', suggestedQuantity: 10,
  });
  const payload = api.dividendVerifyPayload(candidate, {
    amount: '25.00', quantity: '10', actualReceiptDate: '2026-08-05',
    recordDate: '2026-08-01', reviewNote: 'broker statement checked',
  });
  assert.deepEqual({ ...payload }, {
    candidateId: 'ldc_2',
    expectedVersion: 4,
    Amount: '25.00',
    quantity: 10,
    actualReceiptDate: '2026-08-05',
    recordDate: '2026-08-01',
    reviewNote: 'broker statement checked',
  });
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/dividends\/verify'/);
  assert.match(SOURCE, /尚未 Confirm、尚未正式入賬/);
  assert.match(SOURCE, /Quantity 必須按券商派息明細核實並填寫大於 0/);
  assert.doesNotMatch(SOURCE, /留空由後台讀目前正持倉/);
  const verifyStart = SOURCE.indexOf('async function verifyDividend(');
  const verifyEnd = SOURCE.indexOf('\n  async function dismissDividend(', verifyStart);
  const verifySource = SOURCE.slice(verifyStart, verifyEnd);
  assert.doesNotMatch(verifySource, /pending\/confirm/);
  assert.doesNotMatch(verifySource, /tax|fee|withholding/i);
});

test('dismiss requires one explicit reason and cannot create Pending', () => {
  const api = testApi();
  const payload = api.dividendDismissPayload({ candidateId: 'ldc_3', version: 2 }, 'duplicate signal');
  assert.deepEqual({ ...payload }, {
    candidateId: 'ldc_3', expectedVersion: 2, reason: 'duplicate signal',
  });
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/dividends\/dismiss'/);
  assert.match(SOURCE, /未建立 Pending、未修改正式賬本/);
});
