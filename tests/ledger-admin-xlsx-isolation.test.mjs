import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import XLSX from 'xlsx-js-style/dist/xlsx.min.js';

const SOURCE = await readFile(
  new URL('../assets/yc-xlsx-import-worker.js', import.meta.url),
  'utf8',
);
const EVENT_SHEETS = [
  'ETF Stock Buy Record',
  'ETF Stock Sell Record',
  'ETF Stock Dividend Record',
  'Corporate Action Record',
  'Liability Record',
  'Capital Record',
  'Fund Action Record',
];
const DERIVED_SHEETS = [
  'Asset Position Record',
  'Liability Statement',
  'Cash Flow Statement',
  'NAV Statement',
];

function workbookBuffer({ formula = false } = {}) {
  const workbook = XLSX.utils.book_new();
  for (const name of [...EVENT_SHEETS, ...DERIVED_SHEETS]) {
    const rows = name === 'ETF Stock Buy Record'
      ? [
        ['No.', 'Date', 'Ticker', 'Name', 'Quantity', 'Amount', 'Price', 'Notes'],
        [1, '2026-08-05', 'AAA', 'AAA Inc', 1, 10, 10, 'fixture'],
      ]
      : [['No.', 'Date']];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (formula && name === 'ETF Stock Buy Record') {
      sheet.A2 = { t: 'n', f: '1+0', v: 1 };
    }
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['key', 'value'],
    ['portfolio', 'us'],
    ['exportId', 'lex_fixture'],
    ['syncToken', 'lst_fixture'],
  ]), '_YiSync');
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function parseInWorker(buffer) {
  let posted = null;
  const context = {
    XLSX,
    ArrayBuffer,
    DataView,
    Uint8Array,
    TextDecoder,
    Promise,
    importScripts() {},
    postMessage(value) { posted = value; },
  };
  context.self = context;
  vm.runInNewContext(SOURCE, context, { filename: 'yc-xlsx-import-worker.js' });
  context.onmessage({ data: { type: 'PARSE_YICAPITAL_XLSX', buffer } });
  return { posted, context };
}

test('disposable parser returns only allowlisted matrices with network and storage removed', async () => {
  const { posted, context } = parseInWorker(workbookBuffer());
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.deepEqual([...posted.sheetNames], [...EVENT_SHEETS, ...DERIVED_SHEETS, '_YiSync']);
  assert.deepEqual(Object.keys(posted.sheets).sort(), [...EVENT_SHEETS, '_YiSync'].sort());
  assert.equal(posted.sheets['ETF Stock Buy Record'][1][2], 'AAA');
  assert.equal(context.XMLHttpRequest, undefined);
  assert.equal(context.WebSocket, undefined);
  assert.equal(context.indexedDB, undefined);
  await assert.rejects(context.fetch(), /network disabled/);
});

test('disposable parser rejects formulas in the seven event sheets', () => {
  const { posted } = parseInWorker(workbookBuffer({ formula: true }));
  assert.equal(posted.ok, false);
  assert.match(posted.error, /不接受公式/);
});
