import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');

async function workbookApi() {
  const source = await read('assets/yc-ledger-admin.js');
  const window = {
    YC_LEDGER_TEST_MODE: true,
    YCAdmin: { api: async () => ({}), $: () => null, gate: () => {} },
  };
  vm.runInNewContext(source, {
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

test('admin event form treats Amount as the only final cash input', async () => {
  const [html, source] = await Promise.all([
    read('admin-ledger.html'),
    read('assets/yc-ledger-admin.js'),
  ]);

  for (const id of ['tax-mode', 'tax-rate', 'tax-amount', 'fee-amount', 'gross-amount']) {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /Amount 是唯一最終現金金額/);
  assert.match(source, /field\('amount', '最終現金 Amount'/);
  assert.match(source, /參考 Buy Price（可留空）/);
  assert.doesNotMatch(source, /function taxValues\(|function updateTax\(/);
  assert.doesNotMatch(source, /confirm\.disabled\s*=\s*taxNeedsReview/);
  assert.doesNotMatch(source, /請先修改並確認稅項/);
});

test('Excel reverse sync accepts edited final Amount without creating a tax-review gate', async () => {
  const source = await read('assets/yc-ledger-admin.js');
  const start = source.indexOf('function mergeExcelEvent');
  const end = source.indexOf('\n  async function parseImportWorkbook', start);
  assert.ok(start >= 0 && end > start, 'missing bounded mergeExcelEvent implementation');
  const merge = source.slice(start, end);

  assert.match(merge, /setMoney\(event, 'amount', net\)/);
  assert.match(merge, /dropLegacyTaxFields\(event\)/);
  assert.doesNotMatch(merge, /taxReview\(|PENDING_RECONFIRMATION|gross, tax and fees/);
});

test('fallback workbook metadata stays explicit and whole-ledger replacement remains available', async () => {
  const source = await read('assets/yc-ledger-admin.js');
  assert.match(source, /\['servedRevision', data\.servedRevision \?\? data\.ledgerRevision\]/);
  assert.match(source, /\['targetRevision', data\.targetRevision \?\? data\.ledgerRevision\]/);
  assert.match(source, /\['exportMode', data\.exportMode \|\| 'FROZEN_COMPLETE_SNAPSHOT'\]/);
  assert.match(source, /\['reverseSyncMode', data\.reverseSyncMode \|\| 'FULL_LEDGER_REPLACEMENT'\]/);
  assert.match(source, /\['reverseSyncWritable', data\.reverseSyncWritable !== false\]/);
  assert.match(source, /Snapshot Rev \$\{servedRevision\}（動態目標 Rev \$\{targetRevision\}）/);
  assert.doesNotMatch(source, /此 Excel 是只讀凍結 Snapshot/);
  assert.match(source, /sourceSnapshotRevision:/);
  assert.match(source, /replaceAll: true/);
});

test('blank Excel reference price preserves the base price and CPS is ignored', async () => {
  const api = await workbookApi();
  const buy = api.INPUT_DEFS.find(item => item.type === 'BUY');
  const base = {
    schema_version: 1,
    type: 'BUY',
    date: '2026-08-01',
    ticker: 'AAA',
    name: 'AAA',
    quantity: 2,
    amount: 20,
    net_amount: 20,
    price: 8,
    per_share: 10,
    transaction_tax: 1,
    fees: 1,
  };
  const visible = {
    date: '2026-08-01',
    ticker: 'AAA',
    name: 'AAA',
    quantity: 2,
    amount: 24,
    price: null,
    per_share: 999,
    notes: '',
  };

  const blankPrice = api.mergeExcelEvent(buy, visible, base, true);
  assert.equal(blankPrice.price, 8);
  assert.equal(blankPrice.amount, 24);
  assert.equal(blankPrice.per_share, undefined);
  assert.equal(blankPrice.transaction_tax, undefined);
  assert.equal(blankPrice.fees, undefined);

  const overwritten = api.mergeExcelEvent(buy, { ...visible, price: 9 }, base, true);
  assert.equal(overwritten.price, 9);
});
