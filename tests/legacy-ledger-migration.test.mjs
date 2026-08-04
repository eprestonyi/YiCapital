import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DERIVED_SHEETS,
  EVENT_SHEETS,
  migrateLegacyWorkbook,
  stableStringify,
} from '../scripts/migrate-legacy-ledgers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-legacy-ledgers.mjs');
const WORKBOOK_SHEETS = [
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

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellXml(value, row, column) {
  if (value == null) return '';
  const reference = `${columnName(column)}${row}`;
  if (typeof value === 'number') return `<c r="${reference}" t="n"><v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(rows = [], sheetName, options = {}) {
  const leadingRows = sheetName === 'Asset Position Record'
    ? [
      { sourceRow: 1, values: ['As of Date:', options.assetAsOf || '2026-01-08'] },
      { sourceRow: 2, values: [
        'No.', 'Ticker', 'Asset Name', 'Quantity', 'Latest Price (USD)', 'Market Value (USD)',
      ] },
    ]
    : [
      { sourceRow: 1, values: ['Monthly header'] },
      { sourceRow: 2, values: ['No', 'Date'] },
    ];
  const renderedRows = [
    ...leadingRows,
    ...rows,
  ].map(row => {
    const cells = row.values.map((value, index) => cellXml(value, row.sourceRow, index)).join('');
    return `<row r="${row.sourceRow}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>${renderedRows}</sheetData>
    </worksheet>`;
}

async function createWorkbook(baseDirectory, rowsBySheet, options = {}) {
  const buildDirectory = path.join(baseDirectory, 'xlsx-build');
  await mkdir(path.join(buildDirectory, '_rels'), { recursive: true });
  await mkdir(path.join(buildDirectory, 'xl', '_rels'), { recursive: true });
  await mkdir(path.join(buildDirectory, 'xl', 'worksheets'), { recursive: true });

  const overrides = WORKBOOK_SHEETS.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    .join('');
  await writeFile(path.join(buildDirectory, '[Content_Types].xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        ${overrides}
      </Types>`, 'utf8');
  await writeFile(path.join(buildDirectory, '_rels', '.rels'),
    `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`, 'utf8');

  const workbookSheets = WORKBOOK_SHEETS.map((name, index) =>
    `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  await writeFile(path.join(buildDirectory, 'xl', 'workbook.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>${workbookSheets}</sheets>
      </workbook>`, 'utf8');

  const relationships = WORKBOOK_SHEETS.map((_, index) =>
    `<Relationship Id="rId${index + 1}" ` +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
    `Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  await writeFile(path.join(buildDirectory, 'xl', '_rels', 'workbook.xml.rels'),
    `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${relationships}
      </Relationships>`, 'utf8');

  for (let index = 0; index < WORKBOOK_SHEETS.length; index += 1) {
    const name = WORKBOOK_SHEETS[index];
    await writeFile(
      path.join(buildDirectory, 'xl', 'worksheets', `sheet${index + 1}.xml`),
      sheetXml(rowsBySheet[name] || [], name, options),
      'utf8',
    );
  }

  const workbookPath = path.join(baseDirectory, 'synthetic-ledger.xlsx');
  const zip = spawnSync('zip', ['-q', '-r', workbookPath, '.'], {
    cwd: buildDirectory,
    encoding: 'utf8',
  });
  assert.equal(zip.status, 0, zip.stderr || zip.error?.message);
  return workbookPath;
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yc-legacy-ledger-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('migration reads only the seven event sheets and applies legacy normalization rules', async () => {
  await withTempDirectory(async directory => {
    const workbook = await createWorkbook(directory, {
      'ETF Stock Buy Record': [
        { sourceRow: 3, values: [2, '2026-01-02', 'aaa', 'Alpha & Co', 4, 100, 30, 999, 'buy'] },
        { sourceRow: 4, values: ['3', '2026-01-02', 'IGNORED', 'String No', 1, 999, 999, 999, 'ignored'] },
      ],
      'ETF Stock Sell Record': [
        { sourceRow: 3, values: [1, '2026-01-02', 'AAA', 'Alpha & Co', 1, 40, 39, 1, 'sell'] },
      ],
      'ETF Stock Dividend Record': [
        { sourceRow: 3, values: [1, '2026-01-04', 'AAA', 'Alpha & Co', 3, 9, 999, 'dividend'] },
      ],
      'Corporate Action Record': [
        { sourceRow: 3, values: [1, '2026-01-05', 'AAA', 'Alpha & Co', 'SPINOFF', 3,
          "['AAA', 'BBB']", '[3, 3]', 5, 'corp'] },
      ],
      'Liability Record': [
        { sourceRow: 3, values: [1, '2026-01-06', 2, 50, 'loan'] },
      ],
      'Capital Record': [
        { sourceRow: 3, values: [1, '2026-01-01', 'LP1', 120, 20, 10, 999, 'capital'] },
      ],
      'Fund Action Record': [
        { sourceRow: 3, values: [1, '2026-01-07', 'MGMT FEE', 10, 10, -4, 'fee'] },
      ],
      'Asset Position Record': [{ sourceRow: 3, values: [1, '2026-01-01', 'DERIVED'] }],
      'Liability Statement': [{ sourceRow: 3, values: [1, '2026-01-01', 999999] }],
      'Cash Flow Statement': [{ sourceRow: 3, values: [1, '2026-01-01', -999999] }],
      'NAV Statement': [{ sourceRow: 3, values: [1, '2026-01-01', 999999] }],
    });

    const result = await migrateLegacyWorkbook({ portfolio: 'us', input: workbook });
    assert.equal(result.event_count, 7);
    assert.deepEqual(result.event_sheets, EVENT_SHEETS.map(item => item.name));
    assert.deepEqual(result.ignored_derived_sheets, DERIVED_SHEETS);
    assert.equal(result.currency, 'USD');
    assert.equal('generated_at' in result, false);
    assert.deepEqual(result.events.map(event => event.event_type), [
      'CAPITAL', 'SELL', 'BUY', 'DIVIDEND', 'CORPORATE_ACTION', 'LIABILITY', 'FUND_ACTION',
    ]);

    const buy = result.events.find(event => event.event_type === 'BUY');
    assert.equal(buy.payload.ticker, 'AAA');
    assert.equal(buy.payload.amount, 100);
    assert.equal(buy.payload.per_share, 25);
    assert.equal(buy.payload.price, 30);
    assert.equal(buy.payload.net_cash, -100);
    assert.equal(buy.payload.tax_status, 'UNKNOWN_LEGACY');
    assert.equal(buy.payload.gross_amount, null);
    assert.equal(buy.payload.tax_amount, null);
    assert.equal(buy.payload.withholding_tax, null);
    assert.equal(buy.net_cash, -100);
    assert.equal(buy.gross_amount, null);
    assert.equal(buy.tax_amount, null);
    assert.equal(buy.sheet, 'ETF Stock Buy Record');
    assert.equal(buy.source_row, 3);
    assert.equal(buy.source_workbook_sha256, result.source_workbook_sha256);

    const dividend = result.events.find(event => event.event_type === 'DIVIDEND');
    assert.equal(dividend.payload.per_share, 3);
    assert.equal(dividend.payload.price, 3);
    const capital = result.events.find(event => event.event_type === 'CAPITAL');
    assert.equal(capital.payload.units_delta, 10);
    const corporateAction = result.events.find(event => event.event_type === 'CORPORATE_ACTION');
    assert.deepEqual(corporateAction.payload.outputs, [
      { ticker: 'AAA', quantity: 3 },
      { ticker: 'BBB', quantity: 3 },
    ]);
    assert.equal(result.ready_for_confirm, true);
    assert.equal(result.blocking_error_count, 0);
    assert.deepEqual(result.blocking_errors, []);
    assert.equal(result.warnings.some(warning => warning.code === 'NEGATIVE_CASH'), false);
    assert.equal(result.events.some(event => event.payload.ticker === 'DERIVED'), false);
    assert.equal(result.events.some(event => event.payload.ticker === 'IGNORED'), false);
  });
});

test('derived Asset Position is parity evidence and never becomes an operational price seed', async () => {
  await withTempDirectory(async directory => {
    const workbook = await createWorkbook(directory, {
      'Asset Position Record': [
        { sourceRow: 3, values: [1, 'aaa', 'Alpha', 10, 20, 200] },
        { sourceRow: 4, values: [2, 'bbb', 'Beta', 5, 12, 70] },
        { sourceRow: 5, values: [3, 'ZERO', 'Inactive', 0, 99, 0] },
        { sourceRow: 6, values: [4, 'NOPRICE', 'No Price', 5, 0, 0] },
      ],
    }, { assetAsOf: '2026-01-08' });

    const result = await migrateLegacyWorkbook({ portfolio: 'us', input: workbook });
    assert.equal(result.historical_price_row_count, 0);
    assert.deepEqual(result.historical_price_rows, []);
    assert.equal(result.derived_parity_oracle.historical_price_row_count, 2);
    assert.match(result.derived_parity_oracle.historical_price_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.read_only_projection_seed_sheets, []);
    assert.deepEqual(result.derived_parity_oracle_sheets, ['Asset Position Record']);

    const mismatch = result.warnings.find(
      warning => warning.code === 'ASSET_PRICE_SEED_MARKET_VALUE_MISMATCH',
    );
    assert.equal(mismatch.severity, 'warning');
    assert.equal(mismatch.ticker, 'BBB');
    assert.equal(mismatch.source_row, 4);
    assert.equal(mismatch.expected_market_value, 60);
    assert.equal(mismatch.market_value, 70);
    assert.equal(mismatch.market_value_gap, 10);
    assert.equal(result.warning_count, 1);
    assert.equal(result.ready_for_confirm, true);
    assert.equal(result.blocking_error_count, 0);
    assert.deepEqual(result.blocking_errors, []);
  });
});

test('duplicate business rows are warned but preserved and event ids remain deterministic', async () => {
  await withTempDirectory(async directory => {
    const workbook = await createWorkbook(directory, {
      'ETF Stock Buy Record': [
        { sourceRow: 3, values: [1, '2026-01-01', 'AAA', 'Alpha', 2, 50, 25, 25, 'same'] },
        { sourceRow: 4, values: [2, '2026-01-01', 'AAA', 'Alpha', 2, 50, 25, 25, 'same'] },
      ],
      'Corporate Action Record': [
        { sourceRow: 3, values: [1, '2026-01-02', 'AAA', 'Alpha', 'SPLIT', 4,
          "['AAA']", '[8]', 0, 'zero cash must not duplicate the warning'] },
      ],
      'Capital Record': [
        { sourceRow: 3, values: [1, '2026-01-03', 'LP1', 60, 0, 10, 6, 'later'] },
      ],
    });

    const first = await migrateLegacyWorkbook({ portfolio: 'a', input: workbook });
    const second = await migrateLegacyWorkbook({ portfolio: 'a', input: workbook });
    assert.deepEqual(second, first);
    assert.equal(first.event_count, 4);
    const buys = first.events.filter(event => event.event_type === 'BUY');
    assert.equal(buys.length, 2);
    assert.notEqual(buys[0].event_id, buys[1].event_id);
    const expectedDigest = createHash('sha256')
      .update(`ETF Stock Buy Record|3|${stableStringify(buys[0].payload)}`)
      .digest('hex')
      .slice(0, 24);
    assert.equal(buys[0].event_id, `legacy_a_${expectedDigest}`);

    const duplicate = first.warnings.find(warning => warning.code === 'DUPLICATE_LEGACY_ROW');
    assert.deepEqual(duplicate.source_rows, [3, 4]);
    assert.deepEqual(duplicate.event_ids, buys.map(event => event.event_id));
    assert.equal(first.warnings.some(warning => warning.code === 'NEGATIVE_CASH'), false);
    assert.equal(first.events.length, 4);
  });
});

test('CLI writes canonical JSON and dry-run writes only to stdout', async () => {
  await withTempDirectory(async directory => {
    const workbook = await createWorkbook(directory, {
      'Capital Record': [
        { sourceRow: 3, values: [1, '2026-01-01', 'LP1', 100, 0, 10, 999, 'seed'] },
      ],
    });
    const output = path.join(directory, 'result', 'ledger.json');
    const command = spawnSync(process.execPath, [
      SCRIPT,
      '--portfolio', 'hk',
      '--input', workbook,
      '--output', output,
    ], { encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.portfolio_id, 'hk');
    assert.equal(written.currency, 'HKD');
    assert.equal(written.event_count, 1);

    const dryOutput = path.join(directory, 'should-not-exist.json');
    const dryRun = spawnSync(process.execPath, [
      SCRIPT,
      '--portfolio=hk',
      `--input=${workbook}`,
      `--output=${dryOutput}`,
      '--dry-run',
    ], { encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).event_count, 1);
    await assert.rejects(readFile(dryOutput, 'utf8'), error => error.code === 'ENOENT');
  });
});
