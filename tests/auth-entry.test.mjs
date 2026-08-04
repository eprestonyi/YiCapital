import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/worker.js';

const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
const encoder = new TextEncoder();
let googleKid = 0;

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function googleCredential(overrides = {}) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const kid = 'worker-integration-' + (++googleKid);
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const claims = {
    aud: GOOGLE_CLIENT_ID,
    iss: 'https://accounts.google.com',
    sub: 'google-subject-123',
    exp: Math.floor(Date.now() / 1000) + 600,
    email_verified: true,
    email: 'member@example.com',
    name: 'Test Investor',
    ...overrides,
  };
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signed = header + '.' + payload;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    pair.privateKey,
    encoder.encode(signed),
  );
  return { token: signed + '.' + base64Url(signature), jwk, claims };
}

function googleJwksResponse(jwk) {
  return new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}

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

test('authentication CORS reflects only approved YiCapital origins', async () => {
  const env = {
    YC_KV: kvStore(),
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
  };
  for (const origin of ['https://www.yicapital.co', 'https://yicapital.co']) {
    const response = await worker.fetch(new Request('https://portal.test/api/login', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(response.headers.get('Vary') || '', /Origin/);
  }

  const denied = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
    },
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

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
  const google = await googleCredential();
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://www.googleapis.com/oauth2/v3/certs');
    return googleJwksResponse(google.jwk);
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          credential: google.token,
          autoCreate: true,
          terms: true,
          newsletter: true,
        }),
      }),
      {
        YC_KV: kv,
        GOOGLE_CLIENT_ID,
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
    assert.equal(user.newsletter, true);
    assert.ok(kv.values.has('google:jwks:v1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a mapped Google email stays on its ordinary account even if a legacy admin secret exists', async () => {
  const originalFetch = globalThis.fetch;
  const google = await googleCredential({
    sub: 'owner-google-subject',
    email: 'eprestonyi@gmail.com',
    name: 'Ordinary Owner',
  });
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
    assert.equal(String(url), 'https://www.googleapis.com/oauth2/v3/certs');
    return googleJwksResponse(google.jwk);
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.11' },
        body: JSON.stringify({ credential: google.token }),
      }),
      {
        YC_KV: kv,
        GOOGLE_CLIENT_ID,
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

test('Google endpoint distinguishes invalid credentials from a temporary JWKS outage', async () => {
  const originalFetch = globalThis.fetch;
  const kv = kvStore();
  const env = {
    YC_KV: kv,
    GOOGLE_CLIENT_ID,
    ADMIN_USERNAME: 'site-admin',
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
  };
  try {
    const invalidResponse = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.13' },
        body: JSON.stringify({ credential: 'not-a-jwt' }),
      }),
      env,
    );
    assert.equal(invalidResponse.status, 401);
    assert.equal((await invalidResponse.json()).code, 'google_credential_invalid');

    const google = await googleCredential({ email: 'outage@example.com' });
    globalThis.fetch = async () => { throw new TypeError('simulated Google JWKS outage'); };
    const unavailableResponse = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.14' },
        body: JSON.stringify({ credential: google.token }),
      }),
      env,
    );
    assert.equal(unavailableResponse.status, 503);
    assert.equal(unavailableResponse.headers.get('Retry-After'), '5');
    assert.equal((await unavailableResponse.json()).code, 'google_keys_unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google endpoint uses tokeninfo only when the local JWKS host is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const kv = kvStore();
  const google = await googleCredential({ email: 'fallback@example.com' });
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') {
      throw new TypeError('simulated JWKS network outage');
    }
    assert.equal(String(url), 'https://oauth2.googleapis.com/tokeninfo');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({
      ...google.claims,
      exp: String(google.claims.exp),
      email_verified: 'true',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(
      new Request('https://portal.test/api/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.15' },
        body: JSON.stringify({
          credential: google.token,
          autoCreate: true,
          terms: true,
          newsletter: false,
        }),
      }),
      {
        YC_KV: kv,
        GOOGLE_CLIENT_ID,
        ADMIN_USERNAME: 'site-admin',
        ALLOWED_ORIGIN: 'https://www.yicapital.co',
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(kv.values.get('email:fallback@example.com'), body.username);
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

test('logout reports a server-side revocation failure instead of claiming success', async () => {
  const token = 'c'.repeat(64);
  const kv = kvStore({
    ['sess:' + token]: JSON.stringify({ u: 'member', role: 'guest' }),
  });
  kv.delete = async () => { throw new Error('simulated KV delete failure'); };
  const response = await worker.fetch(
    new Request('https://portal.test/api/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    }),
    { YC_KV: kv, ALLOWED_ORIGIN: 'https://www.yicapital.co' },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '2');
});

test('session-store outages return 503 and never masquerade as an expired login', async () => {
  const token = 'f'.repeat(64);
  const kv = kvStore({
    ['sess:' + token]: JSON.stringify({ u: 'member', role: 'guest' }),
  });
  const database = {
    prepare() {
      return { bind() { return { async first() { throw new Error('simulated D1 outage'); } }; } };
    },
  };
  const response = await worker.fetch(
    new Request('https://portal.test/api/me', {
      headers: { Authorization: 'Bearer ' + token },
    }),
    { FEEDBACK_DB: database, YC_KV: kv, ALLOWED_ORIGIN: 'https://www.yicapital.co' },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'auth_store_unavailable');
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
