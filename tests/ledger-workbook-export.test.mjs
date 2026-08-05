import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx-js-style/dist/xlsx.min.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_SOURCE = await readFile(path.join(ROOT, 'assets/yc-ledger-admin.js'), 'utf8');

function workbookTestApi() {
  const window = {
    XLSX,
    crypto: webcrypto,
    YC_LEDGER_TEST_MODE: true,
    YCAdmin: { api: async () => ({}), $: () => null, gate: () => {} },
  };
  const context = {
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
  };
  vm.runInNewContext(ADMIN_SOURCE, context, { filename: 'yc-ledger-admin.js' });
  return window.YCLedgerWorkbookTest;
}

const workbookApi = workbookTestApi();
const DERIVED = new Set(workbookApi.DERIVED_SHEETS);
const REQUIRED_ORDER = [
  ...workbookApi.INPUT_DEFS.slice(0, 4).map(def => def.sheet),
  'Asset Position Record',
  'Liability Record',
  'Liability Statement',
  'Capital Record',
  'Fund Action Record',
  'Cash Flow Statement',
  'NAV Statement',
];

test('canonical style remapping preserves a self-closing worksheet cell', () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>';
  assert.equal(
    workbookApi.remapGeneratedCellStyles(xml, { A1: 5 }, 17, 'sheet-test.xml'),
    '<worksheet><sheetData><row r="1"><c r="A1" s="5"/></row></sheetData></worksheet>',
  );
});

function archive(bytes) {
  return XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' });
}

function partText(container, part) {
  const entry = XLSX.CFB.find(container, `Root Entry/${part}`);
  assert.ok(entry && entry.content, `missing ${part}`);
  return new TextDecoder().decode(entry.content);
}

function xmlNode(xml, tag) {
  const match = xml.match(new RegExp(
    `<${tag}(?:\\s[^>]*)?\\s*\\/>|<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`,
  ));
  return match && match[0] || null;
}

function sheetData(xml) {
  return xmlNode(xml, 'sheetData');
}

function sheetFacts(xml) {
  return sheetData(xml).replace(/\s+s="\d+"/g, '');
}

function cellStyleMap(xml) {
  return Object.fromEntries([...xml.matchAll(/<c\b[^>]*?\br="([^"]+)"[^>]*?\bs="(\d+)"[^>]*>/g)]
    .map(match => [match[1], Number(match[2])]));
}

function buildGeneratedWorkbook(templateWorkbook, currency) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = structuredClone(templateWorkbook.Props || {});
  workbook.Custprops = structuredClone(templateWorkbook.Custprops || {});
  workbook.Workbook = structuredClone(templateWorkbook.Workbook || {});
  workbook.Themes = structuredClone(templateWorkbook.Themes || {});
  workbook.SSF = structuredClone(templateWorkbook.SSF || {});
  const inputBySheet = new Map(workbookApi.INPUT_DEFS.map(def => [def.sheet, def]));
  for (const name of REQUIRED_ORDER) {
    workbook.SheetNames.push(name);
    if (DERIVED.has(name)) {
      const rows = workbookApi.projectionRows({ [name]: [] }, name, currency);
      workbook.Sheets[name] = workbookApi.buildProjectionSheet(
        templateWorkbook.Sheets[name], rows, name,
      );
    } else {
      const def = inputBySheet.get(name);
      workbook.Sheets[name] = workbookApi.buildRecordSheet(
        templateWorkbook.Sheets[name], def, [], currency,
      );
    }
  }
  workbookApi.setSyncSheet(workbook, {
    portfolio: currency === 'USD' ? 'us' : currency === 'HKD' ? 'hk' : 'a',
    currency,
    ledgerRevision: 7,
    servedRevision: 7,
    targetRevision: 9,
    fallback: true,
    exportMode: 'FROZEN_COMPLETE_SNAPSHOT',
    reverseSyncMode: 'FULL_LEDGER_REPLACEMENT',
    reverseSyncWritable: true,
    snapshotAsOf: '2026-08-04',
    snapshotGeneratedAt: '2026-08-05T01:02:03.000Z',
    exportId: 'export-test',
    syncToken: 'sync-test',
    layoutHash: 'layout-test',
  });
  return workbook;
}

for (const spec of [
  { market: 'US', currency: 'USD', template: 'Yi_Capital_US.xlsx' },
  { market: 'HK', currency: 'HKD', template: 'Yi_Capital_HK.xlsx' },
  { market: 'A', currency: 'CNY', template: 'Yi_Capital_A.xlsx' },
]) {
  test(`${spec.market} export preserves the locked template layout and exact style table`, async () => {
    const templateBytes = await readFile(path.join(ROOT, 'assets/data', spec.template));
    const templateWorkbook = XLSX.read(templateBytes, {
      type: 'array', cellDates: false, cellStyles: true,
    });
    const generatedWorkbook = buildGeneratedWorkbook(templateWorkbook, spec.currency);
    const styleManifest = workbookApi.canonicalStyleManifest(generatedWorkbook);
    const generatedBytes = XLSX.write(generatedWorkbook, {
      type: 'array', bookType: 'xlsx', compression: true, cellStyles: true,
    });
    const preservedBytes = await workbookApi.preserveTemplateWorkbookLayout(
      templateBytes.buffer.slice(
        templateBytes.byteOffset, templateBytes.byteOffset + templateBytes.byteLength,
      ),
      generatedBytes,
      REQUIRED_ORDER.length,
      styleManifest,
    );
    const [templateZip, generatedZip, preservedZip] = [
      archive(templateBytes), archive(generatedBytes), archive(preservedBytes),
    ];

    assert.equal(
      partText(preservedZip, 'xl/styles.xml'),
      partText(templateZip, 'xl/styles.xml'),
      'styles.xml must be the original locked template table',
    );
    const templateWorkbookXml = partText(templateZip, 'xl/workbook.xml');
    const preservedWorkbookXml = partText(preservedZip, 'xl/workbook.xml');
    for (const tag of ['workbookPr', 'workbookProtection', 'bookViews', 'definedNames', 'calcPr']) {
      assert.equal(xmlNode(preservedWorkbookXml, tag), xmlNode(templateWorkbookXml, tag), tag);
    }
    for (let index = 1; index <= REQUIRED_ORDER.length; index += 1) {
      const part = `xl/worksheets/sheet${index}.xml`;
      const templateXml = partText(templateZip, part);
      const generatedXml = partText(generatedZip, part);
      const preservedXml = partText(preservedZip, part);
      assert.equal(sheetFacts(preservedXml), sheetFacts(generatedXml), `${part} generated facts changed`);
      for (const tag of ['sheetPr', 'sheetViews', 'sheetFormatPr', 'pageMargins']) {
        assert.equal(xmlNode(preservedXml, tag), xmlNode(templateXml, tag), `${part} ${tag}`);
      }
      assert.deepEqual(
        cellStyleMap(preservedXml),
        { ...styleManifest[part] },
        `${part} canonical cell styles`,
      );
    }

    const syncPart = `xl/worksheets/sheet${REQUIRED_ORDER.length + 1}.xml`;
    assert.equal(
      sheetFacts(partText(preservedZip, syncPart)),
      sheetFacts(partText(generatedZip, syncPart)),
      'sync payload changed while restoring layout',
    );
    assert.deepEqual(
      cellStyleMap(partText(preservedZip, syncPart)),
      { ...styleManifest[syncPart] },
      'sync cells must use the template default style',
    );
    const roundTrip = XLSX.read(preservedBytes, {
      type: 'array', cellDates: false, cellStyles: true,
    });
    assert.deepEqual(roundTrip.SheetNames.slice(0, 11), REQUIRED_ORDER);
    assert.equal(roundTrip.SheetNames[11], '_YiSync');
    assert.equal(roundTrip.Workbook.Sheets[11].Hidden, 2);
    const syncRows = XLSX.utils.sheet_to_json(roundTrip.Sheets._YiSync, {
      header: 1, raw: true, defval: null,
    });
    const sync = Object.fromEntries(syncRows.slice(1).map(row => [row[0], row[1]]));
    assert.equal(sync.ledgerRevision, 7);
    assert.equal(sync.servedRevision, 7);
    assert.equal(sync.targetRevision, 9);
    assert.equal(sync.fallback, true);
    assert.equal(sync.exportMode, 'FROZEN_COMPLETE_SNAPSHOT');
    assert.equal(sync.reverseSyncMode, 'FULL_LEDGER_REPLACEMENT');
    assert.equal(sync.reverseSyncWritable, true);
    assert.equal(sync.snapshotAsOf, '2026-08-04');
    assert.equal(sync.generatedAt, '2026-08-05T01:02:03.000Z');
    for (const def of workbookApi.INPUT_DEFS) {
      const hidden = (roundTrip.Sheets[def.sheet]['!cols'] || [])
        .filter(column => column && column.hidden === true);
      assert.equal(hidden.length, 4, `${def.sheet} hidden reverse-sync columns`);
    }
  });
}

test('export rejects a same-count template style table whose identity changed', async () => {
  const templateBytes = await readFile(path.join(ROOT, 'assets/data', 'Yi_Capital_US.xlsx'));
  const templateWorkbook = XLSX.read(templateBytes, {
    type: 'array', cellDates: false, cellStyles: true,
  });
  const generatedWorkbook = buildGeneratedWorkbook(templateWorkbook, 'USD');
  const styleManifest = workbookApi.canonicalStyleManifest(generatedWorkbook);
  const generatedBytes = XLSX.write(generatedWorkbook, {
    type: 'array', bookType: 'xlsx', compression: true, cellStyles: true,
  });
  const changedTemplate = archive(templateBytes);
  const stylesEntry = XLSX.CFB.find(changedTemplate, 'Root Entry/xl/styles.xml');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stylesXml = decoder.decode(stylesEntry.content);
  const cellXfsAt = stylesXml.indexOf('<cellXfs');
  assert.ok(cellXfsAt >= 0);
  const beforeCellXfs = stylesXml.slice(0, cellXfsAt);
  const changedCellXfs = stylesXml.slice(cellXfsAt).replace('fontId="1"', 'fontId="2"');
  assert.notEqual(changedCellXfs, stylesXml.slice(cellXfsAt));
  stylesEntry.content = encoder.encode(beforeCellXfs + changedCellXfs);
  stylesEntry.size = stylesEntry.content.length;
  const changedBytes = XLSX.CFB.write(changedTemplate, {
    type: 'array', fileType: 'zip', compression: true,
  });

  await assert.rejects(
    workbookApi.preserveTemplateWorkbookLayout(
      changedBytes, generatedBytes, REQUIRED_ORDER.length, styleManifest,
    ),
    /模板樣式表與鎖定格式不一致/,
  );
});
