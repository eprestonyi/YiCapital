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

function workbookSheetNames() {
  const match = SOURCE.match(/const WORKBOOK_SHEETS = \[([\s\S]*?)\n  \];/);
  assert.ok(match, 'WORKBOOK_SHEETS declaration must remain explicit');
  return vm.runInNewContext(`[${match[1]}]`);
}

const EXPECTED_SHEET_ORDER = [
  'ETF Stock Buy Record',
  'ETF Stock Sell Record',
  'ETF Stock Dividend Record',
  'Corporate Action Record',
  'Asset Position Record',
  'Liability Record',
  'Liability Statement',
  'Capital Record',
  'Fund Action Record',
  'Cash Flow Statement',
  'NAV Statement',
];

const EXPECTED_INPUT_HEADERS = {
  'ETF Stock Buy Record': [
    'Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity',
    'Amount (USD)', 'Buy Price (USD)', 'Cost Per Share (USD)', 'Notes',
  ],
  'ETF Stock Sell Record': [
    'Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity',
    'Amount (USD)', 'Sell Price (USD)', 'Proceeds Per Share (USD)', 'Notes',
  ],
  'ETF Stock Dividend Record': [
    'Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Quantity',
    'Amount (USD)', 'Div Per Share (USD)', 'Notes',
  ],
  'Corporate Action Record': [
    'Trade No.', 'Execution Date', 'Ticker', 'Stock/ETF Name', 'Type', 'Quantity',
    'Post Ticker', 'Post Quantity', 'Cash Change (USD)', 'Notes',
  ],
  'Liability Record': [
    'Trade No.', 'Execution Date', 'Interest Expense (USD)', 'Liability Change (USD)', 'Notes',
  ],
  'Capital Record': [
    'Trade No.', 'Execution Date', 'Shareholder', 'Subscription (USD)', 'Redemption (USD)',
    'Unit Price (USD)', 'Quantity', 'Notes',
  ],
  'Fund Action Record': [
    'No.', 'Date', 'Type', 'Quantity', 'Post Quantity', 'Cash Change (USD)', 'Notes',
  ],
};

test('database workbench keeps the exact legacy 11-sheet order', () => {
  assert.deepEqual([...workbookSheetNames()], EXPECTED_SHEET_ORDER);
  assert.match(HTML, /Database Ledger · Excel 原樣工作台/);
  assert.match(HTML, /7 張事件 sheet 的欄名、順序與舊 Excel 一致/);
  assert.match(HTML, /4 張派生表仍由系統計算，不可手改/);
  assert.match(HTML, /id="workbook-tabs"[^>]*role="tablist"/);
});

test('all seven source sheets preserve their exact visible columns and order', () => {
  const api = testApi();
  const defs = [...api.INPUT_DEFS];
  assert.equal(defs.length, 7);
  assert.deepEqual(
    defs.map(def => def.sheet),
    EXPECTED_SHEET_ORDER.filter(name => EXPECTED_INPUT_HEADERS[name]),
  );
  for (const def of defs) {
    const headers = Array.from(def.headers('USD'));
    assert.deepEqual(headers, EXPECTED_INPUT_HEADERS[def.sheet], `${def.sheet} headers drifted`);
    assert.equal(def.visible, headers.length, `${def.sheet} must expose every legacy visible column`);
    assert.equal(def.widths.length, headers.length, `${def.sheet} column widths must stay aligned`);
  }
});

test('seven source sheets are row-selectable and edits create version-guarded correction Pending', () => {
  const formBlock = SOURCE.slice(
    SOURCE.indexOf('const FORM_FIELDS = {'),
    SOURCE.indexOf('\n\n  const state = {'),
  );
  for (const type of ['BUY', 'SELL', 'DIVIDEND', 'CORPORATE_ACTION', 'LIABILITY', 'CAPITAL', 'FUND_ACTION']) {
    assert.match(formBlock, new RegExp(`\\n    ${type}: \\[`), `${type} must have an editable form mapping`);
  }

  const renderStart = SOURCE.indexOf('function renderEventWorkbookSheet(');
  const renderEnd = SOURCE.indexOf('\n  function renderDerivedWorkbookSheet(', renderStart);
  const eventRenderer = SOURCE.slice(renderStart, renderEnd);
  assert.match(eventRenderer, /row\.addEventListener\('click'/);
  assert.match(eventRenderer, /state\.workbookSelection = item/);
  assert.match(eventRenderer, /row\.addEventListener\('dblclick', \(\) => editConfirmed\(item\)\)/);

  assert.match(HTML, /id="workbook-edit-row"[^>]*disabled>修改選中行/);
  assert.match(HTML, /id="workbook-history"[^>]*disabled>查看版本歷史/);
  assert.match(SOURCE, /api\('\/api\/admin\/ledger\/events\/correction'/);
  assert.match(SOURCE, /expectedEventVersion: asNumber\(\$\('edit-event-version'\)\.value, 0\)/);
  assert.match(SOURCE, /expectedLedgerRevision: asNumber\(\$\('edit-ledger-revision'\)\.value, -1\)/);
  assert.match(SOURCE, /正式事件不會原地覆蓋；保存後仍需在 Pending 區 Confirm/);
  assert.match(SOURCE, /events\/history\?portfolio=.*lineageId=/);
});

test('the four derived sheets are explicit AUTO read-only views', () => {
  const api = testApi();
  assert.deepEqual([...api.DERIVED_SHEETS], [
    'Asset Position Record',
    'Liability Statement',
    'Cash Flow Statement',
    'NAV Statement',
  ]);
  assert.match(SOURCE, /button\.dataset\.derived = String\(DERIVED_SHEETS\.includes\(name\)\)/);
  assert.match(SOURCE, /\$\('workbook-edit-row'\)\.disabled = !state\.workbookSelection \|\| DERIVED_SHEETS\.includes\(state\.workbookSheet\)/);

  const derivedBranch = SOURCE.slice(
    SOURCE.indexOf("if (DERIVED_SHEETS.includes(state.workbookSheet))"),
    SOURCE.indexOf('const def = INPUT_BY_SHEET[state.workbookSheet]', SOURCE.indexOf("if (DERIVED_SHEETS.includes(state.workbookSheet))")),
  );
  assert.match(derivedBranch, /renderDerivedWorkbookSheet/);
  assert.match(derivedBranch, /未復權 raw-close 重算，只讀/);
  assert.match(derivedBranch, /return;/);
  assert.match(HTML, /派生 sheet 僅供核對/);
});
