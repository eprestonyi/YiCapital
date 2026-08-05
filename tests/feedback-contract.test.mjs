import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../worker/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(ROOT, relative), 'utf8');

function testEnv(overrides = {}) {
  return {
    YC_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    FEEDBACK_DB: {
      prepare: sql => {
        const query = String(sql);
        const result = query.includes('FROM ledger_outbox')
          ? { pending: 0 }
          : { count: query.includes("'ledger_portfolios'")
            ? 22
            : query.includes("'auth_account_revocations'")
              ? 3
              : query.includes("name = 'auth_rate_limits'")
                ? 1
                : 3 };
        const statement = {
          bind: () => statement,
          first: async () => result,
          all: async () => ({ results: [] }),
        };
        return statement;
      },
    },
    FEEDBACK_RATE_SALT: 'unit-test-only',
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
    ...overrides,
  };
}

test('health exposes the feedback store without leaking configuration', async () => {
  const response = await worker.fetch(
    new Request('https://portal.test/api/health'),
    testEnv(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, 'v9.4-auth-bridge');
  assert.equal(body.admin_google, false);
  assert.equal(body.feedback, true);
  assert.equal(body.ledger, true);
  assert.equal(body.auth_sessions, true);
  assert.equal(body.auth_rate_limit, true);
  assert.equal(body.ledger_outbox_pending, 0);
  assert.equal(body.feedback_rate_limit, true);
  assert.equal('database_id' in body, false);
});

test('Google readiness endpoint warms the persistent signing-key cache', async () => {
  const originalFetch = globalThis.fetch;
  const values = new Map();
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://www.googleapis.com/oauth2/v3/certs');
    return new Response(JSON.stringify({
      keys: [{ kid: 'health-key', kty: 'RSA', alg: 'RS256', use: 'sig', n: 'abc', e: 'AQAB' }],
    }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google/health'),
      testEnv({
        GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        YC_KV: {
          get: async key => values.get(key) || null,
          put: async (key, value) => { values.set(key, value); },
          delete: async () => {},
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mode: 'local' });
    assert.ok(values.has('google:jwks:v1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live monitor and public release marker fail closed on the current auth contract', async () => {
  const [monitor, config] = await Promise.all([
    read('scripts/live-health.mjs'),
    read('assets/portal-config.js'),
  ]);
  assert.match(monitor, /health\.version !== 'v9\.4-auth-bridge'/);
  assert.match(monitor, /health\.auth_sessions !== true/);
  assert.match(monitor, /health\.auth_rate_limit !== true/);
  assert.match(monitor, /health\.ledger !== true/);
  assert.match(monitor, /Number\(health\.ledger_outbox_pending\) !== 0/);
  assert.match(monitor, /health\.ledger_storage_ready !== true/);
  assert.match(monitor, /storage\?\.projectionCurrent !== true \|\| storage\?\.publicCurrent !== true/);
  assert.match(monitor, /\/api\/google\/health/);
  assert.match(config, /window\.YC_RELEASE = 'v9\.4-auth-safety'/);
  assert.match(monitor, /health\.admin_google !== false/);
  assert.doesNotMatch(monitor, /health\.version !== 'v8\.11-terminal-visuals'/);
  assert.doesNotMatch(config, /window\.YC_RELEASE = 'v9\.3-account-center'/);
});

test('health fails closed when the D1 schema is incomplete', async () => {
  const env = testEnv({
    FEEDBACK_DB: {
      prepare: () => ({
        first: async () => ({ count: 2 }),
      }),
    },
  });
  const response = await worker.fetch(
    new Request('https://portal.test/api/health'),
    env,
  );
  assert.equal((await response.json()).feedback, false);
});

test('health fails closed when the dividend candidate inbox migration is missing', async () => {
  const base = testEnv();
  const env = testEnv({
    FEEDBACK_DB: {
      prepare: sql => {
        const query = String(sql);
        if (query.includes("'ledger_portfolios'")) {
          return { bind() { return this; }, first: async () => ({ count: 17 }) };
        }
        return base.FEEDBACK_DB.prepare(sql);
      },
    },
  });
  const response = await worker.fetch(
    new Request('https://portal.test/api/health'),
    env,
  );
  const body = await response.json();
  assert.equal(body.ledger, false);
  assert.equal(body.ledger_storage_ready, false);
});

test('public feedback rejects cross-site requests before touching D1', async () => {
  const response = await worker.fetch(
    new Request('https://portal.test/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.invalid',
      },
      body: JSON.stringify({}),
    }),
    testEnv(),
  );
  assert.equal(response.status, 403);
});

test('public feedback requires JSON and honeypot submissions are not stored', async () => {
  const badType = await worker.fetch(
    new Request('https://portal.test/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    }),
    testEnv(),
  );
  assert.equal(badType.status, 415);

  const honey = await worker.fetch(
    new Request('https://portal.test/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.yicapital.co',
      },
      body: JSON.stringify({ website: 'bot.example' }),
    }),
    testEnv(),
  );
  assert.equal(honey.status, 200);
  assert.deepEqual(await honey.json(), { ok: true, id: null });
});

test('admin feedback log is not readable without an admin session', async () => {
  const response = await worker.fetch(
    new Request('https://portal.test/api/feedback'),
    testEnv(),
  );
  assert.equal(response.status, 401);
});

test('page paths cannot escape the site through a backslash URL', async () => {
  const response = await worker.fetch(
    new Request('https://portal.test/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.yicapital.co',
      },
      body: JSON.stringify({
        submissionId: 'backslash-path-contract',
        category: 'bug',
        locale: 'en',
        message: 'Reject unsafe page link',
        pagePath: '/\\example.invalid',
      }),
    }),
    testEnv(),
  );
  assert.equal(response.status, 400);
});

test('unknown cron schedules are a no-op', async () => {
  let waits = 0;
  await worker.scheduled(
    { cron: '17 1 * * *' },
    testEnv(),
    { waitUntil() { waits += 1; } },
  );
  assert.equal(waits, 0);
});

test('feedback UI is trilingual and sends only minimized diagnostics', async () => {
  const [i18n, widget] = await Promise.all([
    read('assets/yc-i18n.js'),
    read('assets/yc-feedback.js'),
  ]);
  for (const key of [
    'fb.button', 'fb.title', 'fb.category', 'fb.message',
    'fb.privacy', 'fb.submit', 'fb.success', 'fb.error',
  ]) {
    assert.match(i18n, new RegExp(`'${key.replace('.', '\\.')}'\\s*:\\s*\\[`));
  }
  assert.match(i18n, /new URL\('yc-feedback\.js', scriptSrc\)/);
  assert.match(widget, /pagePath:\s*location\.pathname/);
  assert.match(widget, /device:\s*deviceClass\(\)/);
  assert.match(widget, /browser:\s*browserFamily\(\)/);
  assert.doesNotMatch(widget, /location\.href|document\.cookie|diagnostics:\s*\{[^}]*userAgent/s);
});

test('admin renders user text as text, never as HTML', async () => {
  const [admin, users, mail] = await Promise.all([
    read('admin-feedback.html'),
    read('admin-users.html'),
    read('admin-mail.html'),
  ]);
  assert.match(admin, /const message=node\('div','fb-message',item\.message\)/);
  assert.doesNotMatch(admin, /item\.message[^;\n]*innerHTML|innerHTML[^;\n]*item\.message/);
  assert.match(users, /const esc=/);
  assert.match(users, /\$\{esc\(u\.email\|\|'—'\)\}/);
  assert.match(mail, /const esc=/);
  assert.match(mail, /\$\{esc\(u\.email\|\|''\)\}/);
  for (const page of [admin, users, mail]) {
    for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Function(match[1]));
    }
  }
});

test('every top-level public page loads the shared feedback bootstrap', async () => {
  const publicPages = [];
  for (const directory of ['', 'cn', 'en', 'posts', 'cn/posts', 'en/posts']) {
    const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      if (!directory && entry.name.startsWith('admin')) continue;
      publicPages.push(path.join(directory, entry.name));
    }
  }
  assert.ok(publicPages.length >= 45);
  for (const relative of publicPages) {
    assert.match(await read(relative), /assets\/yc-i18n\.js/, relative);
  }
});

test('D1 migration includes query indexes, audit history and rate limits', async () => {
  const migration = await read('migrations/0001_user_feedback.sql');
  assert.match(migration, /submission_id TEXT NOT NULL UNIQUE/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS feedback_changes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS feedback_rate_limits/);
  assert.match(migration, /idx_feedback_status_time/);
  assert.match(migration, /CHECK\(json_valid\(changes_json\)\)/);
});

test('deleting an account anonymizes its linked feedback', async () => {
  const source = await read('worker/worker.js');
  assert.match(source, /'account_anonymized', status, status/);
  assert.match(source, /SET actor_type = 'deleted_user', username = NULL/);
  assert.match(source, /DELETE FROM feedback_rate_limits[\s\S]*substr\(bucket, -length\(\?\)\) = \?/);
  assert.match(source, /hmacSha256Hex\(env\.FEEDBACK_RATE_SALT, actorReference\)/);
});

test('all three terms pages disclose feedback data handling', async () => {
  const [traditional, simplified, english] = await Promise.all([
    read('terms.html'),
    read('cn/terms.html'),
    read('en/terms.html'),
  ]);
  assert.match(traditional, /意見回饋與資料處理/);
  assert.match(simplified, /意见反馈与数据处理/);
  assert.match(english, /Feedback and Data Handling/);
  for (const terms of [traditional, simplified, english]) {
    assert.match(terms, /2026-07-30/);
    assert.match(terms, /information@yicapital\.co/);
  }
});

test('ledger Excel UI isolates external parsing while keeping export and print layout', async () => {
  const [page, ledgerAdmin, importWorker, vendorReadme] = await Promise.all([
    read('admin-ledger.html'),
    read('assets/yc-ledger-admin.js'),
    read('assets/yc-xlsx-import-worker.js'),
    read('assets/vendor/xlsx-js-style-1.2.0/README.md'),
  ]);
  assert.match(page, /assets\/vendor\/xlsx-js-style-1\.2\.0\/xlsx\.min\.js/);
  assert.match(page, /yc-ledger-admin\.js\?v=20260805g/);
  assert.match(page, /data-purpose="excel-export-only"/);
  assert.doesNotMatch(page, /cdn\.jsdelivr\.net|unpkg\.com/);
  assert.doesNotMatch(ledgerAdmin, /cdn\.jsdelivr\.net|unpkg\.com/);
  assert.match(page, /id="import-file"[^>]*type="file"/);
  assert.doesNotMatch(page, /id="import-file"[^>]*\bdisabled\b/);
  assert.match(page, /一次性隔離解析程序/);
  assert.doesNotMatch(ledgerAdmin, /\bXLSX\.read\s*\(/);
  assert.doesNotMatch(ledgerAdmin, /\bXLSX_EXPORT\.read\s*\(/);
  assert.match(ledgerAdmin, /const XLSX_EXPORT = window\.XLSX;/);
  assert.match(ledgerAdmin, /delete window\.XLSX/);
  assert.match(ledgerAdmin, /\$\('import-file'\)\.addEventListener/);
  assert.match(ledgerAdmin, /new Worker\(XLSX_IMPORT_WORKER\)/);
  assert.match(ledgerAdmin, /function readWorkbookInIsolatedWorker\(/);
  assert.match(importWorker, /importScripts\('vendor\/xlsx-js-style-1\.2\.0\/xlsx\.min\.js'\)/);
  assert.match(importWorker, /function preflightZip\(/);
  assert.match(importWorker, /\['fetch', denyNetwork\]/);
  assert.match(importWorker, /\['indexedDB', undefined\]/);
  assert.match(importWorker, /XLSX\.read\(message\.buffer/);
  assert.match(ledgerAdmin, /function readTrustedTemplateLayouts\(/);
  assert.match(vendorReadme, /Never call `XLSX\.read` on the main admin page/);
  assert.match(ledgerAdmin, /\['trade_no', 'tradeNo', 'sequence_no', 'sequence'\]/);
  assert.match(ledgerAdmin, /Hidden:\s*2/);
  assert.match(ledgerAdmin, /'2F5B7C'/);
  assert.match(ledgerAdmin, /'D9E2EC'/);
  assert.match(ledgerAdmin, /\['pre_quantity', 'preQuantity', 'quantity', 'qty'\]/);
  assert.match(ledgerAdmin, /function corporateActionOutput\(event, field\)/);
  assert.match(ledgerAdmin, /function preserveTemplateWorkbookLayout\(/);
  assert.match(ledgerAdmin, /XLSX_EXPORT\.CFB\.read\(new Uint8Array\(templateBuffer\)/);
  assert.match(ledgerAdmin, /'sheetFormatPr'/);
  assert.match(ledgerAdmin, /'pageMargins'/);
  assert.match(ledgerAdmin, /'bookViews'/);
  assert.match(ledgerAdmin, /'calcPr'/);
  assert.match(ledgerAdmin, /function remapGeneratedCellStyles\(/);
  assert.match(ledgerAdmin, /templateStyleCount !== CANONICAL_CELL_STYLES\.length/);
  assert.match(ledgerAdmin, /writeXml\(generatedStyles\.entry, templateStyles\.xml\)/);
  assert.match(ledgerAdmin, /XLSX_EXPORT\.write\(workbook/);
  const vendor = await readFile(path.join(ROOT, 'assets/vendor/xlsx-js-style-1.2.0/xlsx.min.js'));
  assert.equal(
    createHash('sha384').update(vendor).digest('hex'),
    '4cacdd631abfb7d5292eb25c210bb68697d083ea12a0954392159c4b8ceecd09b3413071e6048c8483570f6b86bf48f0',
  );
});
