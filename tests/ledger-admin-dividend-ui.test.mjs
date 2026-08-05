import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const [SOURCE, HTML] = await Promise.all([
  read('assets/yc-ledger-admin.js'),
  read('admin-ledger.html'),
]);

function testApi(apiImpl = async () => ({})) {
  const window = {
    YC_LEDGER_TEST_MODE: true,
    YCAdmin: { api: apiImpl, $: () => null, gate: () => {} },
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

test('action inbox follows nextOffset through more than 500 candidates', async () => {
  const calls = [];
  const rows = (offset, count) => Array.from({ length: count }, (_, index) => ({
    candidateId: `candidate-${offset + index}`,
  }));
  const pages = new Map([
    [0, { portfolio: 'us', items: rows(0, 200), coverage: { revision: 1 }, nextOffset: 200 }],
    [200, { portfolio: 'us', items: rows(200, 200), nextOffset: 400 }],
    [400, { portfolio: 'us', items: rows(400, 101), coverage: { revision: 2 }, nextOffset: null }],
  ]);
  const api = testApi(async path => {
    calls.push(path);
    const offset = Number(new URL(path, 'https://admin.test').searchParams.get('offset'));
    return pages.get(offset);
  });

  const result = await api.fetchAllActionCandidatePages('us', () => true);
  assert.equal(result.items.length, 501);
  assert.equal(result.items[0].candidateId, 'candidate-0');
  assert.equal(result.items.at(-1).candidateId, 'candidate-500');
  assert.equal(result.coverage.revision, 2, 'last non-empty coverage must win');
  assert.deepEqual(calls, [
    '/api/admin/ledger/actions?portfolio=us&state=ALL&limit=200&offset=0',
    '/api/admin/ledger/actions?portfolio=us&state=ALL&limit=200&offset=200',
    '/api/admin/ledger/actions?portfolio=us&state=ALL&limit=200&offset=400',
  ]);
});

test('action pagination retains first-page coverage when later pages omit it', async () => {
  let call = 0;
  const api = testApi(async () => {
    call += 1;
    return call === 1
      ? { portfolio: 'hk', items: [{ candidateId: 'first' }], coverage: { status: 'COMPLETE' }, nextOffset: 200 }
      : { portfolio: 'hk', items: [{ candidateId: 'last' }], nextOffset: null };
  });
  const result = await api.fetchAllActionCandidatePages('hk', () => true);
  assert.equal(result.coverage.status, 'COMPLETE');
  assert.deepEqual(Array.from(result.items, item => item.candidateId), ['first', 'last']);
});

test('action pagination rejects a non-increasing nextOffset', async () => {
  let call = 0;
  const api = testApi(async () => {
    call += 1;
    return { portfolio: 'a', items: [], nextOffset: 200 };
  });
  await assert.rejects(
    api.fetchAllActionCandidatePages('a', () => true),
    /nextOffset 必須嚴格遞增/,
  );
  assert.equal(call, 2, 'must stop on the first repeated offset');
});

test('action pagination stops after a portfolio or sequence switch', async () => {
  let current = true;
  let calls = 0;
  const api = testApi(async () => {
    calls += 1;
    current = false;
    return { portfolio: 'us', items: [{ candidateId: 'stale' }], nextOffset: 200 };
  });
  const result = await api.fetchAllActionCandidatePages('us', () => current);
  assert.equal(result, null);
  assert.equal(calls, 1, 'stale load must not request another page');
  assert.match(SOURCE, /sequence === state\.dividendLoadSequence && portfolio === state\.portfolio/);
});

test('unified action inbox is visible above Pending and scans every held-company event', () => {
  const inbox = HTML.indexOf('id="dividend-inbox-list"');
  const pending = HTML.indexOf('id="pending-list"');
  assert.ok(inbox >= 0 && pending > inbox, 'action inbox must render before Pending');
  assert.match(HTML, /股息／公司行動 · 自動核對/);
  assert.match(HTML, /每家公司真正的正持倉期間掃描/);
  assert.match(HTML, /每個來源事件獨立列出/);
  assert.match(HTML, /同一公司同月兩筆就必須各自錄入或忽略/);
  assert.match(HTML, /股息 Amount、公司行動前後 Quantity 與 Cash Change 全部由你核實/);
  assert.match(HTML, /只建立 Automation Pending，仍须另行 Confirm/);
  assert.match(SOURCE, /\/api\/admin\/ledger\/actions\?portfolio=.*&state=ALL/);
  assert.match(SOURCE, /loadDividendCandidates\(\)/);
});

test('action inbox has separate OPEN and RESOLVED windows with auditable reopen', () => {
  assert.match(HTML, /data-action-state="OPEN">待核實</);
  assert.match(HTML, /data-action-state="RESOLVED">已錄入／已忽略 · 可修改</);
  assert.match(SOURCE, /state\.actionReviewState === 'OPEN'/);
  assert.match(SOURCE, /item\.status === 'PENDING_VERIFICATION'/);
  assert.match(SOURCE, /item\.status !== 'PENDING_VERIFICATION'/);
  assert.match(SOURCE, /action-month/);
  assert.match(SOURCE, /action-company/);
  assert.match(SOURCE, /\$\{handled\}\/\$\{monthAll\.length\} 已處理/);
  assert.match(SOURCE, /重新打開核實/);
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/actions\/reopen'/);
  assert.match(SOURCE, /expectedVersion: candidate\.version/);
  assert.match(SOURCE, /resolutionHistory\.length/);
});

test('stale scan coverage is never presented as complete for a newer ledger revision', () => {
  assert.match(SOURCE, /status === 'STALE' \|\| !current && scannedRevision !== null/);
  assert.match(SOURCE, /正在物化／等待完整持倉期重掃/);
  assert.match(SOURCE, /舊掃描記錄，不視為完成/);
  assert.match(SOURCE, /currentLedgerRevision/);
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
  assert.match(SOURCE, /payload\.candidateType = 'DIVIDEND'/);
  assert.match(SOURCE, /payload\.decision = 'ENTER'/);
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/actions\/resolve'/);
  assert.match(SOURCE, /尚未 Confirm、尚未正式入賬/);
  assert.match(SOURCE, /Quantity 必須按券商派息明細核實並填寫大於 0/);
  assert.match(SOURCE, /Number\(amount\) < 0/);
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
  assert.match(SOURCE, /payload\.candidateType = 'DIVIDEND'/);
  assert.match(SOURCE, /payload\.decision = 'IGNORE'/);
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/actions\/resolve'/);
  assert.match(SOURCE, /未建立 Pending、未修改正式賬本/);
});

test('corporate-action review requires an explicit transformation but never allocates cost', () => {
  assert.match(SOURCE, /function corporateActionCandidateCard\(candidate\)/);
  for (const label of [
    'Type（可修改）',
    '行動前 Quantity（必須核實）',
    'Post Ticker',
    'Post Quantity',
    'Cash Change',
    '生效日期（可修改）',
  ]) assert.ok(SOURCE.includes(label), `missing corporate-action input: ${label}`);

  const start = SOURCE.indexOf('async function resolveCorporateAction(');
  const end = SOURCE.indexOf('\n  async function dismissActionCandidate(', start);
  assert.ok(start >= 0 && end > start, 'missing bounded corporate-action resolver');
  const resolver = SOURCE.slice(start, end);
  assert.match(resolver, /candidateType: 'CORPORATE_ACTION', decision: 'ENTER'/);
  assert.match(resolver, /actionType: inputs\.actionType\.value/);
  assert.match(resolver, /quantity,/);
  assert.match(resolver, /postTicker: inputs\.postTicker\.value\.trim\(\)/);
  assert.match(resolver, /postQuantity: inputs\.postQuantity\.value\.trim\(\), cashChange/);
  assert.match(resolver, /api\('\/api\/admin\/ledger\/actions\/resolve'/);
  assert.match(SOURCE, /只記錄原一股／原持倉變成什麼；不分配成本/);
  assert.doesNotMatch(resolver, /cost|cost_basis|allocate/i);
  assert.doesNotMatch(resolver, /pending\/confirm/);
});

test('resolved entries remain editable through their linked Pending or confirmed correction', () => {
  assert.match(SOURCE, /function modifyResolvedCandidate\(candidate, status\)/);
  assert.match(SOURCE, /pending\.status === 'PENDING'/);
  assert.match(SOURCE, /editPending\(/);
  assert.match(SOURCE, /pending\.status === 'CONFIRMED' && pending\.confirmedEventId/);
  assert.match(SOURCE, /editConfirmed\(item\)/);
  assert.match(SOURCE, /pending\.status === 'CONFIRMED'\s*\? '建立修訂 Pending' : '修改對應 Pending'/);
});
