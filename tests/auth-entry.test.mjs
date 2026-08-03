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

async function passwordHash(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(value => Number.parseInt(value, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

test('email and password resolve the mapped email to the ordinary account', async () => {
  const salt = '00112233445566778899aabbccddeeff';
  const hash = await passwordHash('member-password', salt);
  const kv = kvStore({
    'email:eprestonyi@gmail.com': 'tingxunyi',
    'user:tingxunyi': JSON.stringify({
      u: 'tingxunyi',
      email: 'eprestonyi@gmail.com',
      salt,
      hash,
      provider: 'password',
      role: 'guest',
      disabled: false,
    }),
  });
  const response = await worker.fetch(
    new Request('https://portal.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ username: 'eprestonyi@gmail.com', password: 'member-password' }),
    }),
    {
      YC_KV: kv,
      ADMIN_USERNAME: 'tyi',
      ADMIN_PASSWORD: 'admin-password',
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, 'guest');
  assert.equal(body.username, 'tingxunyi');
  const session = JSON.parse(kv.values.get('sess:' + body.token));
  assert.equal(session.role, 'guest');
  assert.equal(session.u, 'tingxunyi');
});

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

test('a mapped Google email stays on its ordinary account even if a legacy admin secret exists', async () => {
  const originalFetch = globalThis.fetch;
  const user = {
    u: 'tingxunyi',
    email: 'eprestonyi@gmail.com',
    hash: 'password-hash',
    salt: 'password-salt',
    provider: 'password',
    role: 'guest',
    disabled: false,
  };
  const kv = kvStore({
    'email:eprestonyi@gmail.com': 'tingxunyi',
    'user:tingxunyi': JSON.stringify(user),
  });
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?id_token=/);
    return new Response(JSON.stringify({
      aud: 'test-client.apps.googleusercontent.com',
      iss: 'https://accounts.google.com',
      sub: 'owner-google-subject',
      exp: String(Math.floor(Date.now() / 1000) + 600),
      email_verified: 'true',
      email: 'eprestonyi@gmail.com',
      name: 'Ordinary Owner',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.11' },
        body: JSON.stringify({ credential: 'test-google-credential' }),
      }),
      {
        YC_KV: kv,
        GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        ADMIN_USERNAME: 'site-admin',
        ADMIN_GOOGLE_EMAILS: 'eprestonyi@gmail.com',
        ALLOWED_ORIGIN: 'https://www.yicapital.co',
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.role, 'guest');
    assert.equal(body.username, 'tingxunyi');
    const storedUser = JSON.parse(kv.values.get('user:tingxunyi'));
    assert.equal(storedUser.googleSub, 'owner-google-subject');
    assert.equal(storedUser.hash, 'password-hash');
    const session = JSON.parse(kv.values.get('sess:' + body.token));
    assert.equal(session.role, 'guest');
    assert.equal(session.u, 'tingxunyi');
    assert.equal(session.provider, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Google admin sessions are revoked on first use', async () => {
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
    new Request('https://portal.test/api/me', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    {
      YC_KV: kv,
      ADMIN_USERNAME: 'site-admin',
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /未登入/);
  assert.equal(kv.values.has('sess:' + token), false);
});

test('legacy Google admin sessions fail closed when KV deletion is unavailable', async () => {
  const token = 'b'.repeat(64);
  const kv = kvStore({
    ['sess:' + token]: JSON.stringify({
      u: 'site-admin',
      role: 'admin',
      provider: 'google-admin',
      googleEmail: 'owner@example.com',
    }),
  });
  kv.delete = async () => { throw new Error('simulated KV delete failure'); };
  const response = await worker.fetch(
    new Request('https://portal.test/api/me', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    {
      YC_KV: kv,
      ADMIN_USERNAME: 'site-admin',
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /未登入/);
});

test('administrator username and password still create an admin session', async () => {
  const kv = kvStore();
  const response = await worker.fetch(
    new Request('https://portal.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12' },
      body: JSON.stringify({ username: 'site-admin', password: 'strong-password' }),
    }),
    {
      YC_KV: kv,
      ADMIN_USERNAME: 'site-admin',
      ADMIN_PASSWORD: 'strong-password',
      ALLOWED_ORIGIN: 'https://www.yicapital.co',
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, 'admin');
  assert.equal(body.username, 'site-admin');
  const session = JSON.parse(kv.values.get('sess:' + body.token));
  assert.equal(session.role, 'admin');
  assert.equal(session.u, 'site-admin');
  assert.equal(session.provider, undefined);
});
