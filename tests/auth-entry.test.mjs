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

async function passwordHash(password, saltHex, iterations = 100000) {
  const salt = new Uint8Array(saltHex.match(/../g).map(value => Number.parseInt(value, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
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
  const stored = JSON.parse(kv.values.get('user:tingxunyi'));
  assert.equal(stored.passwordIterations, undefined);
  assert.equal(stored.salt, salt);
  assert.equal(stored.hash, hash);
});

test('compatibility bridge verifies a 600k password without downgrading it', async () => {
  const salt = '102132435465768798a9babbdcddedef';
  const hash = await passwordHash('future-member-password', salt, 600000);
  const kv = kvStore({
    'user:future-member': JSON.stringify({
      u: 'future-member', email: 'future@example.com', salt, hash,
      passwordIterations: 600000, provider: 'password', role: 'guest', disabled: false,
    }),
  });
  const response = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.19' },
    body: JSON.stringify({ username: 'future-member', password: 'future-member-password' }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 200);
  const stored = JSON.parse(kv.values.get('user:future-member'));
  assert.equal(stored.passwordIterations, 600000);
  assert.equal(stored.salt, salt);
  assert.equal(stored.hash, hash);
});

test('a current password login does not spend shared KV writes on last-login metadata', async () => {
  const salt = '102132435465768798a9babbdcddedef';
  const hash = await passwordHash('current-member-password', salt, 600000);
  const kv = kvStore({
    'user:current-member': JSON.stringify({
      u: 'current-member', email: 'current@example.com', salt, hash,
      passwordIterations: 600000, provider: 'password', role: 'guest', disabled: false,
    }),
  });
  const originalPut = kv.put.bind(kv);
  let userWrites = 0;
  kv.put = async (key, ...args) => {
    if (key === 'user:current-member') { userWrites += 1; throw new Error('KV put limit exceeded'); }
    return originalPut(key, ...args);
  };
  const response = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.29' },
    body: JSON.stringify({ username: 'current-member', password: 'current-member-password' }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 200);
  assert.equal(userWrites, 0);
  assert.equal([...kv.values.keys()].some(key => key.startsWith('sess:')), true);
});

test('a password-cost upgrade fails closed when the upgraded verifier cannot persist', async () => {
  const salt = '2031425364758697a8b9cadbecfd0e1f';
  const hash = await passwordHash('legacy-member-password', salt);
  const kv = kvStore({
    'user:legacy-member': JSON.stringify({
      u: 'legacy-member', email: 'legacy@example.com', salt, hash,
      provider: 'password', role: 'guest', disabled: false,
    }),
  });
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, ...args) => {
    if (key === 'user:legacy-member') throw new Error('KV put limit exceeded');
    return originalPut(key, ...args);
  };
  const response = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.30' },
    body: JSON.stringify({ username: 'legacy-member', password: 'legacy-member-password' }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'auth_store_unavailable');
  assert.equal([...kv.values.keys()].some(key => key.startsWith('sess:')), false);
  assert.equal(JSON.parse(kv.values.get('user:legacy-member')).passwordIterations, undefined);
});

test('password login does not reveal disabled or Google-only account state', async () => {
  const kv = kvStore({
    'user:disabled-member': JSON.stringify({
      u: 'disabled-member',
      email: 'disabled@example.com',
      disabled: true,
      salt: '00112233445566778899aabbccddeeff',
      hash: 'not-used',
    }),
    'user:google-member': JSON.stringify({
      u: 'google-member',
      email: 'google@example.com',
      disabled: false,
      provider: 'google',
      hash: null,
    }),
  });
  const env = {
    YC_KV: kv,
    ADMIN_USERNAME: 'site-admin',
    ADMIN_PASSWORD: 'strong-administrator-password',
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
  };

  for (const username of ['disabled-member', 'google-member', 'missing-member']) {
    const response = await worker.fetch(new Request('https://portal.test/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.199' },
      body: JSON.stringify({ username, password: 'a sufficiently long password' }),
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: '帳號或密碼錯誤' });
  }
});

test('auth POST rejects hostile origins and malformed or oversized JSON before account mutation', async () => {
  const kv = kvStore();
  const env = { YC_KV: kv, ALLOWED_ORIGIN: 'https://www.yicapital.co' };
  const hostile = await worker.fetch(new Request('https://portal.test/api/forgot', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' },
    body: '{"email":"victim@example.com"}',
  }), env);
  assert.equal(hostile.status, 403);

  const wrongType = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { Origin: 'https://www.yicapital.co', 'Content-Type': 'text/plain' },
    body: '{"username":"member","password":"member-password"}',
  }), env);
  assert.equal(wrongType.status, 415);

  const oversized = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { Origin: 'https://www.yicapital.co', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: 'x'.repeat(17000) }),
  }), env);
  assert.equal(oversized.status, 413);
  assert.equal([...kv.values.keys()].some(key => key.startsWith('user:')), false);
});

test('email registration fails closed when verification delivery is unavailable', async () => {
  const kv = kvStore();
  const response = await worker.fetch(new Request('https://portal.test/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
    body: JSON.stringify({
      username: 'new_member',
      email: 'new-member@example.com',
      password: 'a sufficiently long password',
      terms: true,
    }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 503);
  assert.equal(kv.values.has('user:new_member'), false);
  assert.equal(kv.values.has('email:new-member@example.com'), false);
});

test('signup reports an auth-store outage before sending mail when KV writes are exhausted', async () => {
  const kv = kvStore();
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, ...args) => {
    if (String(key).startsWith('pending:')) throw new Error('KV put() limit exceeded for the day.');
    return originalPut(key, ...args);
  };
  const originalFetch = globalThis.fetch;
  let mailCalls = 0;
  globalThis.fetch = async () => { mailCalls += 1; return new Response('{}', { status: 202 }); };
  try {
    const response = await worker.fetch(new Request('https://portal.test/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.155' },
      body: JSON.stringify({
        username: 'quota_member', email: 'quota@example.com',
        password: 'a sufficiently long password', terms: true,
      }),
    }), { YC_KV: kv, RESEND_API_KEY: 'test-resend-key', ADMIN_USERNAME: 'site-admin' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'auth_store_unavailable');
    assert.ok(Number(response.headers.get('Retry-After')) > 2);
    assert.equal(mailCalls, 0);
    assert.equal([...kv.values.keys()].some(key => /^(?:pending|user|email|username-ci):/.test(key)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verification email failure removes the pending proof and returns a controlled error', async () => {
  const kv = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('simulated email outage'); };
  try {
    const response = await worker.fetch(new Request('https://portal.test/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.156' },
      body: JSON.stringify({
        username: 'mail_member', email: 'mail@example.com',
        password: 'a sufficiently long password', terms: true,
      }),
    }), { YC_KV: kv, RESEND_API_KEY: 'test-resend-key', ADMIN_USERNAME: 'site-admin' });
    assert.equal(response.status, 502);
    assert.equal(kv.values.has('pending:mail@example.com'), false);
    assert.equal(kv.values.has('user:mail_member'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a verification proof cannot create an account when one-time deletion fails', async () => {
  const pendingKey = 'pending:consume@example.com';
  const kv = kvStore({
    [pendingKey]: JSON.stringify({
      u: 'consume_member', email: 'consume@example.com', code: '123456', tries: 0,
      salt: '00112233445566778899aabbccddeeff', hash: 'hash',
      passwordIterations: 600000, expiresAt: Date.now() + 600000,
    }),
  });
  const originalDelete = kv.delete.bind(kv);
  kv.delete = async key => {
    if (key === pendingKey) throw new Error('simulated KV delete outage');
    return originalDelete(key);
  };
  const response = await worker.fetch(new Request('https://portal.test/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.157' },
    body: JSON.stringify({ email: 'consume@example.com', code: '123456' }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 503);
  assert.equal(kv.values.has('user:consume_member'), false);
  assert.equal([...kv.values.keys()].some(key => key.startsWith('sess:')), false);
  assert.equal(kv.values.has(pendingKey), true);
});

test('verification codes keep an absolute expiry and recheck case-insensitive identity ownership', async () => {
  const expiredKv = kvStore({
    'pending:expired@example.com': JSON.stringify({
      u: 'expired_user', email: 'expired@example.com', code: '123456', tries: 0,
      salt: '00112233445566778899aabbccddeeff', hash: 'hash', expiresAt: Date.now() - 1,
    }),
  });
  const expired = await worker.fetch(new Request('https://portal.test/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.56' },
    body: JSON.stringify({ email: 'expired@example.com', code: '123456' }),
  }), { YC_KV: expiredKv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(expired.status, 410);
  assert.equal(expiredKv.values.has('pending:expired@example.com'), false);

  const collisionKv = kvStore({
    'user:TakenID': JSON.stringify({ u: 'TakenID', email: 'owner@example.com' }),
    'pending:new@example.com': JSON.stringify({
      u: 'takenid', email: 'new@example.com', code: '654321', tries: 0,
      salt: '00112233445566778899aabbccddeeff', hash: 'hash',
      passwordIterations: 600000, expiresAt: Date.now() + 600000,
    }),
  });
  const collision = await worker.fetch(new Request('https://portal.test/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.57' },
    body: JSON.stringify({ email: 'new@example.com', code: '654321' }),
  }), { YC_KV: collisionKv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(collision.status, 409);
  assert.equal(collisionKv.values.has('user:takenid'), false);
});

test('account creation rolls back indexes and issues no session after a partial KV failure', async () => {
  const pendingKey = 'pending:partial@example.com';
  const kv = kvStore({
    [pendingKey]: JSON.stringify({
      u: 'partial_member', email: 'partial@example.com', code: '654321', tries: 0,
      salt: '00112233445566778899aabbccddeeff', hash: 'hash',
      passwordIterations: 600000, expiresAt: Date.now() + 600000,
    }),
  });
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, ...args) => {
    if (key === 'email:partial@example.com') throw new Error('simulated partial account write');
    return originalPut(key, ...args);
  };
  const response = await worker.fetch(new Request('https://portal.test/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.158' },
    body: JSON.stringify({ email: 'partial@example.com', code: '654321' }),
  }), { YC_KV: kv, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 503);
  assert.equal(kv.values.has(pendingKey), false);
  assert.equal(kv.values.has('username-ci:partial_member'), false);
  assert.equal(kv.values.has('email:partial@example.com'), false);
  assert.equal(kv.values.has('user:partial_member'), false);
  assert.equal([...kv.values.keys()].some(key => key.startsWith('sess:')), false);
});

test('password recovery stays enumeration-safe when its KV challenge cannot be written', async () => {
  const kv = kvStore({
    'email:known@example.com': 'known-member',
    'user:known-member': JSON.stringify({ u: 'known-member', email: 'known@example.com' }),
  });
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, ...args) => {
    if (String(key).startsWith('reset:')) throw new Error('KV put limit exceeded');
    return originalPut(key, ...args);
  };
  const originalFetch = globalThis.fetch;
  let mailCalls = 0;
  globalThis.fetch = async () => { mailCalls += 1; return new Response('{}', { status: 202 }); };
  try {
    const known = await worker.fetch(new Request('https://portal.test/api/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.159' },
      body: JSON.stringify({ email: 'known@example.com' }),
    }), { YC_KV: kv, RESEND_API_KEY: 'test-resend-key' });
    const missing = await worker.fetch(new Request('https://portal.test/api/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.160' },
      body: JSON.stringify({ email: 'missing@example.com' }),
    }), { YC_KV: kv, RESEND_API_KEY: 'test-resend-key' });
    assert.equal(known.status, 200);
    assert.equal(missing.status, 200);
    assert.deepEqual(await known.json(), await missing.json());
    assert.equal(mailCalls, 0);
    assert.equal(kv.values.has('reset:known@example.com'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('password reset consumes its proof before a failed account write', async () => {
  const salt = '30415263748596a7b8c9daebfc0d1e2f';
  const oldHash = await passwordHash('old-member-password', salt);
  const kv = kvStore({
    'user:reset-member': JSON.stringify({
      u: 'reset-member', email: 'reset@example.com', salt, hash: oldHash,
      passwordIterations: 100000, provider: 'password', role: 'guest', disabled: false,
    }),
    'reset:reset@example.com': JSON.stringify({
      code: '123456', u: 'reset-member', tries: 0, expiresAt: Date.now() + 600000,
    }),
  });
  const originalPut = kv.put.bind(kv);
  kv.put = async (key, ...args) => {
    if (key === 'user:reset-member') throw new Error('KV put limit exceeded');
    return originalPut(key, ...args);
  };
  const database = {
    prepare() {
      return { bind() { return { async first() { return { count: 1 }; }, async run() { return { success: true }; } }; } };
    },
    async batch() { return []; },
  };
  const response = await worker.fetch(new Request('https://portal.test/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.161' },
    body: JSON.stringify({
      email: 'reset@example.com', code: '123456', password: 'a new sufficiently long password',
    }),
  }), { YC_KV: kv, FEEDBACK_DB: database, ADMIN_USERNAME: 'site-admin' });
  assert.equal(response.status, 503);
  assert.equal(kv.values.has('reset:reset@example.com'), false);
  const stored = JSON.parse(kv.values.get('user:reset-member'));
  assert.equal(stored.hash, oldHash);
  assert.equal(stored.passwordIterations, 100000);
});

test('server roles gate account profile and administrator APIs independently of browser state', async () => {
  const now = Date.now();
  const memberToken = 'd'.repeat(64);
  const kv = kvStore({
    ['sess:' + memberToken]: JSON.stringify({
      u: 'member', role: 'guest', issuedAt: now, lastSeenAt: now,
      expiresAt: now + 86400000, absoluteExpiresAt: now + 172800000,
    }),
    'user:member': JSON.stringify({ u: 'member', email: 'member@example.com', disabled: false }),
  });
  const env = { YC_KV: kv, ADMIN_USERNAME: 'site-admin', ADMIN_PASSWORD: 'strong-administrator-password' };
  const adminLogin = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20' },
    body: JSON.stringify({ username: 'site-admin', password: 'strong-administrator-password' }),
  }), env);
  assert.equal(adminLogin.status, 200);
  const adminToken = (await adminLogin.json()).token;

  const adminProfile = await worker.fetch(new Request('https://portal.test/api/account/profile', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'not allowed' }),
  }), env);
  assert.equal(adminProfile.status, 403);

  const memberUsers = await worker.fetch(new Request('https://portal.test/api/users', {
    headers: { Authorization: 'Bearer ' + memberToken },
  }), env);
  assert.equal(memberUsers.status, 403);

  const anonymousUsers = await worker.fetch(new Request('https://portal.test/api/users'), env);
  assert.equal(anonymousUsers.status, 401);
});

test('member profile returns connected identities and persists display, avatar and newsletter preferences', async () => {
  const salt = '11112222333344445555666677778888';
  const hash = await passwordHash('member-password', salt);
  const kv = kvStore({
    'email:member@example.com': 'member_id',
    'user:member_id': JSON.stringify({
      u: 'member_id',
      name: 'Member Name',
      email: 'member@example.com',
      googleSub: 'google-member-123',
      salt,
      hash,
      provider: 'password',
      role: 'guest',
      disabled: false,
      newsletter: false,
      created: '2026-08-01T00:00:00.000Z',
    }),
  });
  const env = {
    YC_KV: kv,
    ADMIN_USERNAME: 'site-admin',
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
  };
  const login = await worker.fetch(new Request('https://portal.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.21' },
    body: JSON.stringify({ username: 'member@example.com', password: 'member-password' }),
  }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const me = await worker.fetch(new Request('https://portal.test/api/me', {
    headers: { Authorization: 'Bearer ' + token },
  }), env);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).connections, { email: true, google: true });

  const avatar = 'data:image/png;base64,aGVsbG8=';
  const update = await worker.fetch(new Request('https://portal.test/api/account/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'CF-Connecting-IP': '203.0.113.21',
    },
    body: JSON.stringify({
      displayName: 'Yi Researcher',
      username: 'member_id',
      newsletter: true,
      avatarDataUrl: avatar,
      email: 'attacker@example.com',
      googleSub: 'attacker-google-subject',
    }),
  }), env);
  assert.equal(update.status, 200);
  const profile = await update.json();
  assert.equal(profile.displayName, 'Yi Researcher');
  assert.equal(profile.newsletter, true);
  assert.equal(profile.avatar, avatar);
  assert.equal(profile.email, 'member@example.com');
  assert.deepEqual(profile.connections, { email: true, google: true });
  const stored = JSON.parse(kv.values.get('user:member_id'));
  assert.equal(stored.email, 'member@example.com');
  assert.equal(stored.googleSub, 'google-member-123');
  assert.equal(stored.name, 'Yi Researcher');
  assert.equal(stored.newsletter, true);
});

test('member profile rejects a case-insensitive ID collision without changing the account', async () => {
  const kv = kvStore({
    'user:alpha': JSON.stringify({ u: 'alpha', email: 'alpha@example.com', newsletter: false }),
    'user:TakenID': JSON.stringify({ u: 'TakenID', email: 'taken@example.com', newsletter: false }),
    ['sess:' + 'a'.repeat(64)]: JSON.stringify({
      u: 'alpha', role: 'guest', issuedAt: Date.now(), lastSeenAt: Date.now(),
      expiresAt: Date.now() + 86400000, absoluteExpiresAt: Date.now() + 172800000,
    }),
  });
  const response = await worker.fetch(new Request('https://portal.test/api/account/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + 'a'.repeat(64),
      'CF-Connecting-IP': '203.0.113.22',
    },
    body: JSON.stringify({ username: 'takenid' }),
  }), {
    YC_KV: kv,
    ADMIN_USERNAME: 'site-admin',
    ALLOWED_ORIGIN: 'https://www.yicapital.co',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /ID/);
  assert.ok(kv.values.has('user:alpha'));
  assert.equal(kv.values.has('user:takenid'), false);
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
  assert.match(session.provider, /^admin-password-v1:[a-f0-9]{64}$/);
});
