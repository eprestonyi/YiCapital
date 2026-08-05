import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ADMIN_SOURCE, ADMIN_HTML] = await Promise.all([
  readFile(path.join(ROOT, 'assets/yc-ledger-admin.js'), 'utf8'),
  readFile(path.join(ROOT, 'admin-ledger.html'), 'utf8'),
]);

function pipelineApi() {
  const window = {
    YC_LEDGER_TEST_MODE: true,
    YCAdmin: { api: async () => ({}), $: () => null, gate: () => {} },
  };
  vm.runInNewContext(ADMIN_SOURCE, {
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
  return window.YCLedgerWorkbookTest.pipelineStatusView;
}

const view = pipelineApi();

test('admin ledger renders pricing, accounting, snapshot, and Excel as separate stages', () => {
  for (const id of ['pipeline-pricing', 'pipeline-accounting', 'pipeline-snapshot', 'pipeline-excel']) {
    assert.match(ADMIN_HTML, new RegExp(`id=["']${id}["']`));
  }
  assert.match(ADMIN_HTML, /Excel 是後台完整快照的輸出，不是動態計算的輸入/);
});

test('pending NAV replay keeps the last complete snapshot available for Excel', () => {
  const status = view({
    raw_nav_portfolios: {
      us: {
        ledgerRevision: 112,
        ready: false,
        reason: 'RAW_NAV_COMPLETED_SESSION_STALE',
        priceTapeId: 'raw-close:us:112',
        tapeThrough: '2026-08-04',
        latestNavDate: '2026-07-30',
      },
    },
    ledger_storage_portfolios: {
      us: {
        ledgerRevision: 112,
        projectionRevision: 110,
        publicRevision: 110,
        projectionCurrent: false,
        publicCurrent: false,
      },
    },
  }, 'us', 112);

  assert.equal(status.targetRevision, 112);
  assert.equal(status.completedSnapshotRevision, 110);
  assert.equal(status.pricing.state, 'done');
  assert.equal(status.accounting.state, 'active');
  assert.match(status.accounting.detail, /2026-07-30 → 2026-08-04/);
  assert.equal(status.snapshot.state, 'active');
  assert.match(status.snapshot.detail, /Revision 110 穩定可讀/);
  assert.equal(status.excel.state, 'done');
  assert.match(status.excel.detail, /導出凍結 Snapshot Revision 110/);
  assert.match(status.excel.detail, /動態 Revision 112 仍在計算/);
  assert.equal(status.exportRevision, 110);
  assert.equal(status.currentReady, false);
  assert.equal(status.exportReady, true);
});

test('Excel becomes available only when raw NAV and the current stored snapshot align', () => {
  const status = view({
    rawNavPortfolios: {
      us: {
        ledgerRevision: 112,
        ready: true,
        priceTapeId: 'raw-close:us:112',
        tapeThrough: '2026-08-04',
      },
    },
    ledgerStoragePortfolios: {
      us: {
        ledgerRevision: 112,
        projectionRevision: 112,
        publicRevision: 112,
        projectionCurrent: true,
        publicCurrent: true,
      },
    },
  }, 'us', 112);

  assert.equal(status.accounting.state, 'done');
  assert.equal(status.snapshot.state, 'done');
  assert.equal(status.excel.state, 'done');
  assert.match(status.excel.detail, /Snapshot Revision 112/);
  assert.equal(status.exportRevision, 112);
  assert.equal(status.currentReady, true);
  assert.equal(status.exportReady, true);
});

test('public-only storage does not falsely enable Excel without a materialized snapshot', () => {
  const status = view({
    raw_nav_portfolios: {
      us: { ledgerRevision: 4, ready: false, reason: 'RECALC_NAV_OUTBOX_PENDING' },
    },
    ledger_storage_portfolios: {
      us: {
        ledgerRevision: 4,
        projectionRevision: null,
        publicRevision: 3,
        projectionCurrent: false,
        publicCurrent: false,
      },
    },
  }, 'us', 4);

  assert.equal(status.completedSnapshotRevision, null);
  assert.equal(status.exportRevision, null);
  assert.equal(status.exportReady, false);
});
