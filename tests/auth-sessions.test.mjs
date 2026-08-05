import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_IDLE_TTL_MS,
  AuthStoreUnavailableError,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  authRateAllowed,
  cleanupAuthState,
  getSession,
  newSession,
  revokeSession,
  revokeUserSessions,
} from '../worker/auth-sessions.js';

const DAY = 24 * 60 * 60 * 1000;

function kvStore(options = {}) {
  const values = new Map();
  return {
    values,
    async get(key) {
      if (options.hideReads) return null;
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      if (options.failWrites) throw new Error('simulated KV write limit');
      values.set(key, String(value));
    },
    async delete(key) {
      if (!options.staleDeletes) values.delete(key);
    },
  };
}

function authDatabase() {
  const sessions = new Map();
  const revocations = new Map();
  const accountRevocations = new Map();
  const rateLimits = new Map();
  const normalize = sql => sql.replace(/\s+/g, ' ').trim().toLowerCase();

  return {
    sessions,
    revocations,
    accountRevocations,
    rateLimits,
    prepare(sql) {
      const query = normalize(sql);
      return {
        bind(...values) {
          return {
            async first() {
              if (query.includes('left join auth_sessions')) {
                const row = sessions.get(values[0]);
                return {
                  ...(row || {}),
                  account_revoked_before: row && accountRevocations.get(row.username)
                    ? accountRevocations.get(row.username).revoked_before
                    : null,
                  is_revoked: revocations.has(values[0]) ? 1 : 0,
                };
              }
              if (query.startsWith('select revoked_before from auth_account_revocations')) {
                return accountRevocations.get(values[0]) || null;
              }
              if (query.startsWith('insert into auth_rate_limits')) {
                const current = rateLimits.get(values[0]);
                const next = {
                  count: current ? current.count + 1 : 1,
                  expires_at: values[1],
                };
                rateLimits.set(values[0], next);
                return { count: next.count };
              }
              throw new Error('unsupported first query: ' + query);
            },
            async run() {
              if (query.startsWith('insert into auth_sessions')) {
                sessions.set(values[0], {
                  username: values[1],
                  role: values[2],
                  provider: values[3],
                  issued_at: values[4],
                  last_seen_at: values[5],
                  expires_at: values[6],
                  absolute_expires_at: values[7],
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('update auth_sessions')) {
                const row = sessions.get(values[2]);
                let changed = 0;
                if (row && row.expires_at === values[3]) {
                  row.last_seen_at = values[0];
                  row.expires_at = values[1];
                  changed = 1;
                }
                return { success: true, meta: { changes: changed } };
              }
              if (query.startsWith('insert into auth_session_revocations')) {
                if (query.includes('select token_hash')) {
                  for (const [tokenHash, row] of sessions) {
                    if (row.username !== values[2]) continue;
                    const current = revocations.get(tokenHash);
                    revocations.set(tokenHash, {
                      revoked_at: values[0],
                      expires_at: Math.max(current ? current.expires_at : 0, values[1]),
                    });
                  }
                } else {
                  const current = revocations.get(values[0]);
                  revocations.set(values[0], {
                    revoked_at: values[1],
                    expires_at: Math.max(current ? current.expires_at : 0, values[2]),
                  });
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('insert into auth_account_revocations')) {
                const current = accountRevocations.get(values[0]);
                accountRevocations.set(values[0], {
                  revoked_before: Math.max(current ? current.revoked_before : 0, values[1]),
                  expires_at: Math.max(current ? current.expires_at : 0, values[2]),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_sessions where token_hash')) {
                sessions.delete(values[0]);
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_sessions where username')) {
                for (const [key, row] of sessions) {
                  if (row.username === values[0]) sessions.delete(key);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_sessions where expires_at')) {
                for (const [key, row] of sessions) {
                  if (row.expires_at <= values[0] || row.absolute_expires_at <= values[1]) sessions.delete(key);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_session_revocations')) {
                for (const [key, row] of revocations) {
                  if (row.expires_at <= values[0]) revocations.delete(key);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_account_revocations')) {
                for (const [key, row] of accountRevocations) {
                  if (row.expires_at <= values[0]) accountRevocations.delete(key);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (query.startsWith('delete from auth_rate_limits')) {
                for (const [key, row] of rateLimits) {
                  if (row.expires_at <= values[0]) rateLimits.delete(key);
                }
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error('unsupported run query: ' + query);
            },
          };
        },
        async first() {
          if (query.includes("'auth_account_revocations'")) return { count: 3 };
          if (query.includes("name = 'auth_rate_limits'")) return { count: 1 };
          throw new Error('unsupported unbound first query: ' + query);
        },
      };
    },
  };
}

function requestWithToken(token) {
  return new Request('https://portal.test/api/me', {
    headers: { Authorization: 'Bearer ' + token },
  });
}

test('new sessions are immediately readable from D1 even when KV reads are stale', async () => {
  const database = authDatabase();
  const kv = kvStore({ hideReads: true });
  const now = Date.UTC(2026, 7, 4);
  const env = {
    FEEDBACK_DB: database,
    YC_KV: kv,
    ADMIN_USERNAME: 'tyi',
    ADMIN_PASSWORD: 'a-strong-administrator-password',
    FEEDBACK_RATE_SALT: 'test-rate-salt',
  };
  const token = await newSession(env, 'tyi', 'admin', {}, { now: () => now });

  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(database.sessions.has(token), false, 'D1 must never store the bearer token in plaintext');
  assert.equal(database.sessions.size, 1);
  assert.equal(kv.values.has('sess:' + token), false, 'D1 sessions must not duplicate plaintext bearer tokens in KV');

  const session = await getSession(requestWithToken(token), env, { now: () => now + 1000 });
  assert.equal(session.u, 'tyi');
  assert.equal(session.role, 'admin');
  assert.equal(session.store, 'd1');
  assert.equal(session.expiresAt, now + ADMIN_SESSION_IDLE_TTL_MS);
  assert.equal(session.absoluteExpiresAt, now + ADMIN_SESSION_ABSOLUTE_TTL_MS);
});

test('administrator credential rotation revokes existing sessions automatically', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const now = Date.UTC(2026, 7, 4);
  const env = {
    FEEDBACK_DB: database,
    YC_KV: kv,
    ADMIN_USERNAME: 'tyi',
    ADMIN_PASSWORD: 'first-strong-administrator-password',
    FEEDBACK_RATE_SALT: 'test-rate-salt',
  };
  const token = await newSession(env, 'tyi', 'admin', {}, { now: () => now });
  assert.equal((await getSession(requestWithToken(token), env, { now: () => now + 1000 })).role, 'admin');

  const rotated = { ...env, ADMIN_PASSWORD: 'rotated-strong-administrator-password' };
  assert.equal(await getSession(requestWithToken(token), rotated, { now: () => now + 2000 }), null);
  assert.equal(database.sessions.size, 0);
});

test('a valid D1 administrator hit scrubs a legacy plaintext KV copy', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const now = Date.UTC(2026, 7, 4);
  const env = {
    FEEDBACK_DB: database,
    YC_KV: kv,
    ADMIN_USERNAME: 'tyi',
    ADMIN_PASSWORD: 'a-strong-administrator-password',
    FEEDBACK_RATE_SALT: 'test-rate-salt',
  };
  const token = await newSession(env, 'tyi', 'admin', {}, { now: () => now });
  kv.values.set('sess:' + token, JSON.stringify({ u: 'tyi', role: 'admin' }));

  const session = await getSession(requestWithToken(token), env, { now: () => now + 1000 });

  assert.equal(session.role, 'admin');
  assert.equal(session.store, 'd1');
  assert.equal(kv.values.has('sess:' + token), false);
  assert.equal(database.sessions.size, 1);
  assert.equal(database.revocations.size, 0);
});

test('a rollback-expanded administrator idle deadline is revoked and its KV copy is removed', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const issuedAt = Date.UTC(2026, 7, 4);
  const env = {
    FEEDBACK_DB: database,
    YC_KV: kv,
    ADMIN_USERNAME: 'tyi',
    ADMIN_PASSWORD: 'a-strong-administrator-password',
    FEEDBACK_RATE_SALT: 'test-rate-salt',
  };
  const token = await newSession(env, 'tyi', 'admin', {}, { now: () => issuedAt });
  const row = [...database.sessions.values()][0];

  // Simulate the previous Worker refreshing this privileged row with its
  // global 30-day idle limit, while also recreating the legacy KV bearer copy.
  row.last_seen_at = issuedAt + 60 * 60 * 1000;
  row.expires_at = row.last_seen_at + SESSION_IDLE_TTL_MS;
  row.absolute_expires_at = issuedAt + ADMIN_SESSION_ABSOLUTE_TTL_MS;
  kv.values.set('sess:' + token, JSON.stringify({
    u: 'tyi',
    role: 'admin',
    issuedAt,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: issuedAt + SESSION_ABSOLUTE_TTL_MS,
  }));

  const session = await getSession(requestWithToken(token), env, {
    now: () => row.last_seen_at + 1000,
  });

  assert.equal(session, null);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.revocations.size, 1);
  assert.equal(kv.values.has('sess:' + token), false);
});

test('an administrator absolute deadline beyond seven days is revoked independently', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const issuedAt = Date.UTC(2026, 7, 4);
  const env = {
    FEEDBACK_DB: database,
    YC_KV: kv,
    ADMIN_USERNAME: 'tyi',
    ADMIN_PASSWORD: 'a-strong-administrator-password',
    FEEDBACK_RATE_SALT: 'test-rate-salt',
  };
  const token = await newSession(env, 'tyi', 'admin', {}, { now: () => issuedAt });
  const row = [...database.sessions.values()][0];
  row.expires_at = issuedAt + ADMIN_SESSION_IDLE_TTL_MS;
  row.absolute_expires_at = issuedAt + ADMIN_SESSION_ABSOLUTE_TTL_MS + 1;

  assert.equal(await getSession(requestWithToken(token), env, {
    now: () => issuedAt + 1000,
  }), null);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.revocations.size, 1);
});

test('a bound but unavailable D1 session store cannot silently create KV-only sessions', async () => {
  const database = {
    prepare() {
      return { bind() { return { async run() { throw new Error('simulated D1 failure'); } }; } };
    },
  };
  await assert.rejects(
    newSession({ FEEDBACK_DB: database, YC_KV: kvStore() }, 'member', 'guest'),
    error => error instanceof AuthStoreUnavailableError && error.operation === 'session_create',
  );
});

test('a D1 read outage never bypasses an authoritative revocation through KV', async () => {
  const token = 'e'.repeat(64);
  const kv = kvStore();
  kv.values.set('sess:' + token, JSON.stringify({ u: 'member', role: 'guest' }));
  const database = {
    prepare() {
      return { bind() { return { async first() { throw new Error('simulated D1 outage'); } }; } };
    },
  };

  await assert.rejects(
    getSession(requestWithToken(token), { FEEDBACK_DB: database, YC_KV: kv }),
    error => error instanceof AuthStoreUnavailableError && error.operation === 'session_read_d1',
  );
});

test('legacy KV sessions migrate lazily without logging the user out', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const token = 'a'.repeat(64);
  kv.values.set('sess:' + token, JSON.stringify({ u: 'member', role: 'guest' }));
  const now = Date.UTC(2026, 7, 4);

  const session = await getSession(requestWithToken(token), {
    FEEDBACK_DB: database,
    YC_KV: kv,
  }, { now: () => now });

  assert.equal(session.u, 'member');
  assert.equal(session.store, 'd1-migrated');
  assert.equal(database.sessions.size, 1);
});

test('active sessions renew near idle expiry but never pass the absolute cap', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const createdAt = Date.UTC(2026, 0, 1);
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const token = await newSession(env, 'member', 'guest', {}, { now: () => createdAt });

  const renewed = await getSession(requestWithToken(token), env, {
    now: () => createdAt + 24 * DAY,
  });
  assert.equal(renewed.expiresAt, createdAt + 54 * DAY);

  const row = [...database.sessions.values()][0];
  row.expires_at = createdAt + SESSION_ABSOLUTE_TTL_MS - DAY;
  row.absolute_expires_at = createdAt + SESSION_ABSOLUTE_TTL_MS;
  const capped = await getSession(requestWithToken(token), env, {
    now: () => createdAt + SESSION_ABSOLUTE_TTL_MS - 5 * DAY,
  });
  assert.equal(capped.expiresAt, createdAt + SESSION_ABSOLUTE_TTL_MS);
});

test('activity well before the expiry window still preserves a full idle period', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const createdAt = Date.UTC(2026, 0, 1);
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const token = await newSession(env, 'member', 'guest', {}, { now: () => createdAt });

  const active = await getSession(requestWithToken(token), env, {
    now: () => createdAt + 22 * DAY,
  });
  assert.equal(active.expiresAt, createdAt + 52 * DAY);
  const returned = await getSession(requestWithToken(token), env, {
    now: () => createdAt + 31 * DAY,
  });
  assert.equal(returned.u, 'member');
  assert.equal(returned.expiresAt, createdAt + 61 * DAY);
});

test('logout tombstones D1 authority and removes any legacy KV copy', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const token = await newSession(env, 'member', 'guest');

  assert.equal(await revokeSession(env, token), true);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.revocations.size, 1);
  assert.equal(kv.values.has('sess:' + token), false);
  assert.equal(await getSession(requestWithToken(token), env), null);
});

test('a stale KV delete cannot resurrect a session after logout', async () => {
  const database = authDatabase();
  const kv = kvStore({ staleDeletes: true });
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const token = await newSession(env, 'member', 'guest');
  kv.values.set('sess:' + token, JSON.stringify({ u: 'member', role: 'guest' }));

  assert.equal(await revokeSession(env, token), true);
  assert.equal(kv.values.has('sess:' + token), true, 'simulated remote KV location still sees the old value');
  assert.equal(await getSession(requestWithToken(token), env), null);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.revocations.size, 1);
});

test('password-change revocation blocks both D1 and unmigrated legacy sessions for the account', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const now = Date.UTC(2026, 7, 4);
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const d1Token = await newSession(env, 'member', 'guest', {}, { now: () => now - DAY });
  const legacyToken = 'd'.repeat(64);
  kv.values.set('sess:' + legacyToken, JSON.stringify({ u: 'member', role: 'guest' }));

  assert.equal(await revokeUserSessions(env, 'member', { now: () => now }), true);
  assert.equal(await getSession(requestWithToken(d1Token), env, { now: () => now + 1 }), null);
  assert.equal(await getSession(requestWithToken(legacyToken), env, { now: () => now + 1 }), null);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.accountRevocations.size, 1);
});

test('D1 rate limiting increments atomically without touching a hot KV key', async () => {
  const database = authDatabase();
  const kv = kvStore({ failWrites: true });
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const request = new Request('https://portal.test/api/login', {
    headers: { 'CF-Connecting-IP': '203.0.113.8' },
  });
  const now = Date.UTC(2026, 7, 4);

  assert.equal(await authRateAllowed(request, env, 'login', 2, 900, { now: () => now }), true);
  assert.equal(await authRateAllowed(request, env, 'login', 2, 900, { now: () => now }), true);
  assert.equal(await authRateAllowed(request, env, 'login', 2, 900, { now: () => now }), false);
  assert.equal(database.rateLimits.size, 1);
});

test('subject rate limits stay shared across source IP addresses', async () => {
  const database = authDatabase();
  const env = { FEEDBACK_DB: database, YC_KV: kvStore(), FEEDBACK_RATE_SALT: 'test-rate-salt' };
  const first = new Request('https://portal.test/api/login', {
    headers: { 'CF-Connecting-IP': '203.0.113.8' },
  });
  const second = new Request('https://portal.test/api/login', {
    headers: { 'CF-Connecting-IP': '198.51.100.9' },
  });
  const options = { now: () => Date.UTC(2026, 7, 4), identity: 'Member@Example.com' };

  assert.equal(await authRateAllowed(first, env, 'login-subject', 1, 900, options), true);
  assert.equal(await authRateAllowed(second, env, 'login-subject', 1, 900, options), false);
  assert.equal(database.rateLimits.size, 1);
});

test('rate-limit identity is keyed with the configured salt', async () => {
  const request = new Request('https://portal.test/api/login', {
    headers: { 'CF-Connecting-IP': '203.0.113.8' },
  });
  const first = authDatabase();
  const second = authDatabase();
  const now = Date.UTC(2026, 7, 4);

  await authRateAllowed(request, { FEEDBACK_DB: first, FEEDBACK_RATE_SALT: 'salt-a' }, 'login', 2, 900, { now: () => now });
  await authRateAllowed(request, { FEEDBACK_DB: second, FEEDBACK_RATE_SALT: 'salt-b' }, 'login', 2, 900, { now: () => now });
  assert.notEqual([...first.rateLimits.keys()][0], [...second.rateLimits.keys()][0]);
});

test('scheduled cleanup removes expired session, revocation and rate buckets', async () => {
  const database = authDatabase();
  const kv = kvStore();
  const now = Date.UTC(2026, 7, 4);
  const env = { FEEDBACK_DB: database, YC_KV: kv };
  const token = await newSession(env, 'member', 'guest', {}, { now: () => now - SESSION_ABSOLUTE_TTL_MS - DAY });
  await revokeSession(env, 'b'.repeat(64));
  await authRateAllowed(
    new Request('https://portal.test/api/login', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
    env,
    'login',
    2,
    60,
    { now: () => now - 120_000 },
  );

  assert.equal(database.sessions.size, 1);
  const cleanupAt = Math.max(now, Date.now()) + SESSION_ABSOLUTE_TTL_MS + DAY;
  assert.equal(await cleanupAuthState(env, { now: () => cleanupAt }), true);
  assert.equal(database.sessions.size, 0);
  assert.equal(database.revocations.size, 0);
  assert.equal(database.rateLimits.size, 0);
  assert.match(token, /^[a-f0-9]{64}$/);
});

test('a failed legacy rate-limit write is an infrastructure error, not a false abuse denial', async () => {
  const request = new Request('https://portal.test/api/login', {
    headers: { 'CF-Connecting-IP': '203.0.113.9' },
  });
  await assert.rejects(
    authRateAllowed(request, { YC_KV: kvStore({ failWrites: true }) }, 'login', 2, 900),
    error => error instanceof AuthStoreUnavailableError && error.status === 503,
  );
});
