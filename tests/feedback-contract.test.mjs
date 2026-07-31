import assert from 'node:assert/strict';
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
      prepare: () => ({
        first: async () => ({ count: 3 }),
      }),
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
  assert.equal(body.version, 'v8.11-terminal-visuals');
  assert.equal(body.feedback, true);
  assert.equal(body.feedback_rate_limit, true);
  assert.equal('database_id' in body, false);
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
