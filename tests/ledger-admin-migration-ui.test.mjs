import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function assertElement(source, tag, id) {
  const pattern = new RegExp(
    `<${escapeRegExp(tag)}\\b(?=[^>]*\\bid=["']${escapeRegExp(id)}["'])[^>]*>`,
    'i',
  );
  assert.match(source, pattern, `missing <${tag}>#${id}`);
}

function functionBlock(source, name) {
  const declaration = new RegExp(
    `(?:^|\\n)\\s{2}(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`,
  ).exec(source);
  assert.ok(declaration, `missing function ${name}`);
  const start = declaration.index;
  const following = source.slice(start + declaration[0].length);
  const next = /\n\s{2}(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(following);
  return source.slice(start, next ? start + declaration[0].length + next.index : source.length);
}

test('admin ledger exposes the complete one-time legacy migration controls', async () => {
  const html = await read('admin-ledger.html');

  assertElement(html, 'details', 'legacy-migration');
  assertElement(html, 'textarea', 'legacy-json');
  assertElement(html, 'button', 'parse-legacy');
  assertElement(html, 'button', 'preview-legacy');
  assertElement(html, 'code', 'legacy-required-phrase');
  assertElement(html, 'input', 'legacy-confirm-phrase');
  assertElement(html, 'button', 'confirm-legacy');
  assertElement(html, 'button', 'drain-legacy-outbox');
  assertElement(html, 'dd', 'legacy-import-id');
  assertElement(html, 'dd', 'legacy-migration-hash');

  for (const id of [
    'legacy-ack-negative-cash',
    'legacy-ack-duplicates',
    'legacy-ack-unknown-tax',
    'legacy-ack-historical-nav',
    'legacy-ack-historical-prices',
  ]) assertElement(html, 'input', id);

  assert.match(html, /id=["']legacy-required-phrase["'][^>]*>\s*CONFIRM LEGACY US\s*</i);
  const legacyPanel = html.slice(
    html.indexOf('id="legacy-migration"'),
    html.indexOf('</details>', html.indexOf('id="legacy-migration"')),
  );
  assert.doesNotMatch(legacyPanel, /<input\b(?=[^>]*\btype=["']file["'])[^>]*>/i);
});

test('legacy migration UI uses preview, signed confirm, and outbox contracts', async () => {
  const source = await read('assets/yc-ledger-admin.js');
  const preview = functionBlock(source, 'previewLegacyMigration');
  const confirm = functionBlock(source, 'confirmLegacyMigration');
  const drain = functionBlock(source, 'drainLegacyOutbox');
  const acknowledgement = functionBlock(source, 'legacyAcknowledgement');
  const confirmationGate = functionBlock(source, 'updateLegacyConfirmation');

  assert.match(preview, /api\(\s*["']\/api\/admin\/ledger\/migration\/preview["']/);
  assert.match(preview, /method\s*:\s*["']POST["']/);
  assert.match(preview, /body\s*:\s*JSON\.stringify\(\s*parsed\.payload\s*\)/);

  assert.match(confirm, /api\(\s*["']\/api\/admin\/ledger\/migration\/confirm["']/);
  assert.match(confirm, /method\s*:\s*["']POST["']/);
  assert.match(confirm, /importId\s*:\s*state\.legacyImportId/);
  assert.match(confirm, /migrationHash\s*:\s*state\.legacyMigrationHash/);
  assert.match(confirm, /acknowledgement\s*:\s*\{/);
  assert.match(confirm, /phrase\s*:\s*\$\(["']legacy-confirm-phrase["']\)\.value/);
  assert.match(confirm, /\.\.\.legacyAcknowledgement\(\)/);

  const ackKeys = [...source.matchAll(/\{\s*key\s*:\s*["']([^"']+)["'][^}]*\binput\s*:\s*["']legacy-ack-/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(ackKeys, [
    'duplicates',
    'historicalNav',
    'historicalPrices',
    'negativeCash',
    'unknownTax',
  ]);
  assert.match(acknowledgement, /Object\.fromEntries\(\s*LEGACY_ACKS\.map\(/);
  assert.match(acknowledgement, /item\.key/);
  assert.match(acknowledgement, /\.checked\s*===\s*true/);

  assert.match(source, /return\s+`CONFIRM LEGACY \$\{String\(portfolio \|\| state\.portfolio\)\.toUpperCase\(\)\}`/);
  assert.match(confirmationGate, /phraseInput\.value\s*===\s*expectedPhrase/);
  assert.match(confirmationGate, /!phraseOk/);

  assert.match(drain, /api\(\s*["']\/api\/admin\/ledger\/outbox["']/);
  assert.match(drain, /method\s*:\s*["']POST["']/);
  assert.match(drain, /portfolio\s*:\s*state\.portfolio/);
  assert.match(drain, /result\.pending\s*===\s*true/);
  assert.match(drain, /item\.complete\s*===\s*false/);
  assert.match(drain, /請繼續 Drain/);
});

test('legacy migration stays in memory and delegates bearer handling to YCAdmin', async () => {
  const source = await read('assets/yc-ledger-admin.js');
  const start = source.indexOf('function legacyExpectedPhrase');
  const end = source.indexOf('if (window.YC_LEDGER_TEST_MODE', start);
  assert.ok(start >= 0 && end > start, 'missing bounded legacy migration implementation');
  const legacyFlow = source.slice(start, end);

  assert.match(source, /const\s*\{\s*api\s*,\s*\$\s*\}\s*=\s*window\.YCAdmin/);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage)\b/);
  assert.doesNotMatch(source, /\bAuthorization\b|\bBearer\b|["']yc-token["']/i);

  assert.doesNotMatch(legacyFlow, /\bfetch\s*\(|\bXMLHttpRequest\b|\bFormData\b|\bsendBeacon\s*\(/);
  assert.doesNotMatch(legacyFlow, /\/api\/(?:publish|upload(?:pdf)?)\b|api\.github\.com/i);
  assert.doesNotMatch(legacyFlow, /\.writeFile\b|showSaveFilePicker\b/);
  assert.match(legacyFlow, /const\s+text\s*=\s*\$\(["']legacy-json["']\)\.value/);
  assert.match(legacyFlow, /JSON\.parse\(text\)/);
});
