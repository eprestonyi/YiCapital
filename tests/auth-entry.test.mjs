import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/worker.js';

function kvStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list({ prefix } = {}) {
      return {
        keys: [...values.keys()]
          .filter(key => !prefix || key.startsWith(prefix))
          .map(name => ({ name })),
      };
    },
  };
}

test('Google one-click registration creates a passwordless member session', async () => {
  const originalFetch = globalThis.fetch;
  const kv = kvStore();
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?id_token=/);
    return new Response(JSON.stringify({
      aud: 'test-client.apps.googleusercontent.com',
      iss: 'https://accounts.google.com',
      sub: 'google-subject-123',
      exp: String(Math.floor(Date.now() / 1000) + 600),
      email_verified: 'true',
      email: 'member@example.com',
      name: 'Test Investor',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          credential: 'test-google-credential',
          autoCreate: true,
          terms: true,
        }),
      }),
      {
        YC_KV: kv,
        GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        ADMIN_USERNAME: 'site-admin',
        ALLOWED_ORIGIN: 'https://www.yicapital.co',
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.role, 'guest');
    assert.match(body.token, /^[a-f0-9]{64}$/);
    assert.equal(kv.values.get('email:member@example.com'), body.username);
    const user = JSON.parse(kv.values.get('user:' + body.username));
    assert.equal(user.provider, 'google');
    assert.equal(user.googleSub, 'google-subject-123');
    assert.equal(user.hash, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('removing a Google admin from the allowlist revokes protected routes immediately', async () => {
  const token = 'a'.repeat(64);
  const kv = kvStore({
    ['sess:' + token]: JSON.stringify({
      u: 'site-admin',
      role: 'admin',
      provider: 'google-admin',
      googleEmail: 'owner@example.com',
      googleSub: 'owner-subject',
    }),
  });
  const response = await worker.fetch(
    new Request('https://portal.test/api/users', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    {
      YC_KV: kv,
      ADMIN_USERNAME: 'site-admin',
      ADMIN_GOOGLE_EMAILS: 'another-owner@example.com',
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /授權已撤銷/);
});
