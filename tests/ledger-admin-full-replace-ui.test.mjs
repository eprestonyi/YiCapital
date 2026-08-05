import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import XLSX from 'xlsx-js-style/dist/xlsx.min.js';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const [SOURCE, HTML] = await Promise.all([
  read('assets/yc-ledger-admin.js'),
  read('admin-ledger.html'),
]);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const offset = start >= 0 ? start : asyncStart;
  assert.ok(offset >= 0, `missing function ${name}`);
  const following = source.slice(offset + 1);
  const next = /\n  (?:async )?function [A-Za-z_$][\w$]*\(/.exec(following);
  return source.slice(offset, next ? offset + 1 + next.index : source.length);
}

function testApi() {
  const window = {
    XLSX,
    YC_LEDGER_TEST_MODE: true,
    YC_LEDGER_IMPORT_READER: async buffer => {
      const workbook = XLSX.read(buffer, {
        type: 'array', cellDates: false, cellStyles: false, WTF: false,
      });
      return {
        ok: true,
        sheetNames: workbook.SheetNames.slice(),
        sheets: Object.fromEntries(workbook.SheetNames.map(name => [
          name,
          XLSX.utils.sheet_to_json(workbook.Sheets[name], {
            header: 1, raw: true, defval: null, blankrows: false,
          }),
        ])),
      };
    },
    YCAdmin: { api: async () => ({}), $: () => null, gate: () => {} },
  };
  vm.runInNewContext(SOURCE, {
    window,
    XLSX,
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

test('local parser accepts a fallback signed snapshot for full-ledger preview', async () => {
  const api = testApi();
  const workbook = XLSX.utils.book_new();
  for (const def of api.INPUT_DEFS) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([def.headers('USD')]),
      def.sheet,
    );
  }
  api.setSyncSheet(workbook, {
    portfolio: 'us',
    currency: 'USD',
    ledgerRevision: 110,
    servedRevision: 110,
    targetRevision: 112,
    fallback: true,
    exportMode: 'FROZEN_COMPLETE_SNAPSHOT',
    reverseSyncMode: 'FULL_LEDGER_REPLACEMENT',
    reverseSyncWritable: true,
    exportId: 'fallback-export',
    syncToken: 'signed-token',
    layoutHash: 'layout-v1',
  });
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const parsed = await api.parseImportWorkbook(bytes);

  assert.equal(parsed.baseLedgerRevision, 110);
  assert.equal(parsed.manifest.servedRevision, 110);
  assert.equal(parsed.manifest.targetRevision, 112);
  assert.equal(parsed.manifest.reverseSyncMode, 'FULL_LEDGER_REPLACEMENT');
  assert.equal(parsed.manifest.reverseSyncWritable, true);
  assert.equal(parsed.rows.length, 0);
});

test('preview distinguishes CREATE UPDATE MISSING and blockers', () => {
  const summary = testApi().summarizeImportPreview({
    operations: [
      { operation: 'CREATE', operationId: 'create-1' },
      { operation: 'UPDATE', operationId: 'update-1' },
      { operation: 'MISSING_IN_EXCEL', operationId: 'missing-1' },
      { operation: 'CONFLICT', operationId: 'conflict-1', error: 'stale row' },
    ],
  });

  assert.deepEqual({ ...summary.counts }, {
    CREATE: 1,
    UPDATE: 1,
    MISSING: 1,
    BLOCKERS: 1,
  });
  assert.equal(summary.blockers.length, 1);

  const declared = testApi().summarizeImportPreview({
    operations: [], errorCount: 0, conflictCount: 2,
  });
  assert.equal(declared.counts.BLOCKERS, 2);
  assert.equal(declared.blockers.length, 1);
});

test('UI uses one explicit whole-ledger confirmation and no per-row selection payload', () => {
  for (const id of ['import-replace-all-ack', 'import-confirm-reason', 'confirm-import']) {
    assert.match(HTML, new RegExp(`id=["']${id}["']`));
  }
  assert.match(HTML, /舊版本仍完整保留在不可變歷史中，不刪除、不 truncate/);

  const confirm = functionBlock(SOURCE, 'confirmImport');
  assert.match(confirm, /replaceAll:\s*true/);
  assert.match(confirm, /confirmation:\s*\{\s*replaceAll:\s*true,\s*reason\s*\}/);
  assert.match(confirm, /const expectedLedgerRevision = state\.importExpectedRevision/);
  assert.match(confirm, /body:\s*JSON\.stringify\(\{[\s\S]*expectedLedgerRevision,/);
  assert.doesNotMatch(confirm, /selectedOperationIds/);
  assert.doesNotMatch(SOURCE, /function selectedOperationIds\(|function updateImportSelection\(/);
  assert.doesNotMatch(SOURCE, /只讀 Snapshot，不可反向同步/);
  assert.match(SOURCE, /const MAX_IMPORT_ROWS = 1000/);
  assert.doesNotMatch(SOURCE, /請分批處理/);

  const api = testApi();
  assert.equal(api.importConfirmationState({
    importId: 'import-1', blockerCount: 1, acknowledged: true, reason: 'checked',
  }).canConfirm, false);
  assert.equal(api.importConfirmationState({
    importId: 'import-1', blockerCount: 0, acknowledged: false, reason: 'checked',
  }).canConfirm, false);
  assert.equal(api.importConfirmationState({
    importId: 'import-1', blockerCount: 0, acknowledged: true, reason: 'checked',
  }).canConfirm, true);
});

test('whole-ledger confirmation exposes visible busy, receipt, error, and lock states', () => {
  assert.match(HTML, /id=["']confirm-import["'][^>]*aria-busy=["']false["']/);
  assert.match(HTML, /id=["']import-selection["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  assert.match(HTML, /\.danger-solid:disabled\{/);
  assert.match(HTML, /#import-selection\[data-state="success"\]/);
  assert.match(HTML, /#import-preview\.processed \.import-op/);

  const confirm = functionBlock(SOURCE, 'confirmImport');
  assert.match(confirm, /if \(state\.importConfirming \|\| state\.importProcessed\) return/);
  assert.match(confirm, /state\.importConfirming = true/);
  assert.match(confirm, /setImportFeedback\('active'/);
  assert.match(confirm, /state\.importProcessed = true/);
  assert.match(confirm, /classList\.add\('processed'\)/);
  assert.match(confirm, /setImportFeedback\('success', receipt\.text\)/);
  assert.match(confirm, /setImportFeedback\('error'/);
  assert.match(confirm, /updateImportConfirmation\(\)/);
});

test('whole-ledger success receipt contains revision, replacement count, and Hong Kong time', () => {
  const receipt = testApi().importReceipt({
    ledgerRevision: 115,
    eventCount: 37,
  }, 0, '2026-08-05T15:09:38.000Z');

  assert.equal(receipt.revision, 115);
  assert.equal(receipt.replaced, 37);
  assert.match(receipt.time, /2026/);
  assert.match(receipt.time, /23:09:38/);
  assert.match(receipt.text, /Ledger Revision 115/);
  assert.match(receipt.text, /37 events/);
  assert.match(receipt.text, /Preview 已處理並鎖定/);
});
