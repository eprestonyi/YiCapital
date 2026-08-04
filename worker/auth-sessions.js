const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

export const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const LEGACY_KV_TTL_SECONDS = Math.ceil(SESSION_IDLE_TTL_MS / 1000);
const encoder = new TextEncoder();

export class AuthStoreUnavailableError extends Error {
  constructor(operation = 'auth_store') {
    super('Authentication state is temporarily unavailable');
    this.name = 'AuthStoreUnavailableError';
    this.code = 'AUTH_STORE_UNAVAILABLE';
    this.status = 503;
    this.operation = operation;
  }
}

function reportStoreFailure(operation, error) {
  console.error('auth_store_failed', operation, error instanceof Error ? error.name : 'unknown');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256Hex(secret, value) {
  if (!secret) return sha256Hex(value);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function authRateAllowed(request, env, action, limit, windowSeconds, options = {}) {
  const address = request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') || 'unknown';
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  const window = Math.floor(now / (windowSeconds * 1000));
  const identity = await hmacSha256Hex(
    env && (env.AUTH_RATE_SALT || env.FEEDBACK_RATE_SALT),
    address.split(',')[0].trim(),
  );
  const bucketKey = ['authrate', action, identity, window].join(':');
  const expiresAt = (window + 1) * windowSeconds * 1000 + 60 * 1000;
  const database = sessionDatabase(env);

  if (database) {
    try {
      const row = await database.prepare(`
        INSERT INTO auth_rate_limits (bucket_key, count, expires_at)
        VALUES (?, 1, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          count = auth_rate_limits.count + 1,
          expires_at = excluded.expires_at
        RETURNING count
      `).bind(bucketKey, expiresAt).first();
      return Number(row && row.count || 0) <= limit;
    } catch (error) {
      reportStoreFailure('rate_limit_d1', error);
      throw new AuthStoreUnavailableError('rate_limit_d1');
    }
  }

  if (!env || !env.YC_KV) throw new AuthStoreUnavailableError('rate_limit_store');
  try {
    const count = Number(await env.YC_KV.get(bucketKey) || 0) + 1;
    await env.YC_KV.put(bucketKey, String(count), { expirationTtl: windowSeconds + 60 });
    return count <= limit;
  } catch (error) {
    reportStoreFailure('rate_limit_kv', error);
    throw new AuthStoreUnavailableError('rate_limit_kv');
  }
}

function bearerToken(request) {
  const match = String(request.headers.get('Authorization') || '')
    .match(/^Bearer\s+([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function sessionDatabase(env) {
  return env && env.FEEDBACK_DB && typeof env.FEEDBACK_DB.prepare === 'function'
    ? env.FEEDBACK_DB
    : null;
}

async function readD1Session(env, tokenHash) {
  const database = sessionDatabase(env);
  if (!database) return { available: false, revoked: false, row: null };
  try {
    const row = await database.prepare(`
      SELECT
        session.username,
        session.role,
        session.provider,
        session.issued_at,
        session.last_seen_at,
        session.expires_at,
        session.absolute_expires_at,
        account.revoked_before AS account_revoked_before,
        CASE WHEN revoked.token_hash IS NULL THEN 0 ELSE 1 END AS is_revoked
      FROM (SELECT ? AS token_hash) AS lookup
      LEFT JOIN auth_sessions AS session
        ON session.token_hash = lookup.token_hash
      LEFT JOIN auth_session_revocations AS revoked
        ON revoked.token_hash = lookup.token_hash
      LEFT JOIN auth_account_revocations AS account
        ON account.username = session.username
    `).bind(tokenHash).first();
    return {
      available: true,
      revoked: Number(row && row.is_revoked || 0) === 1,
      row: row && row.username ? row : null,
    };
  } catch (error) {
    reportStoreFailure('session_read_d1', error);
    return { available: false, revoked: false, row: null };
  }
}

async function writeD1Session(env, tokenHash, session) {
  const database = sessionDatabase(env);
  if (!database) return false;
  try {
    await database.prepare(`
      INSERT INTO auth_sessions (
        token_hash,
        username,
        role,
        provider,
        issued_at,
        last_seen_at,
        expires_at,
        absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        username = excluded.username,
        role = excluded.role,
        provider = excluded.provider,
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at,
        absolute_expires_at = excluded.absolute_expires_at
    `).bind(
      tokenHash,
      session.u,
      session.role,
      session.provider || null,
      session.issuedAt,
      session.lastSeenAt,
      session.expiresAt,
      session.absoluteExpiresAt,
    ).run();
    return true;
  } catch (error) {
    reportStoreFailure('session_write_d1', error);
    return false;
  }
}

async function refreshD1Session(env, tokenHash, session) {
  const database = sessionDatabase(env);
  if (!database) return false;
  try {
    const result = await database.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?, expires_at = ?
      WHERE token_hash = ? AND expires_at = ?
    `).bind(
      session.lastSeenAt,
      session.expiresAt,
      tokenHash,
      session.previousExpiresAt,
    ).run();
    return Number(result && result.meta && result.meta.changes || 0) > 0;
  } catch (error) {
    reportStoreFailure('session_refresh_d1', error);
    return false;
  }
}

async function tombstoneD1Session(env, tokenHash, now) {
  const database = sessionDatabase(env);
  if (!database) return true;
  try {
    await database.prepare(`
      INSERT INTO auth_session_revocations (
        token_hash,
        revoked_at,
        expires_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        revoked_at = excluded.revoked_at,
        expires_at = MAX(auth_session_revocations.expires_at, excluded.expires_at)
    `).bind(tokenHash, now, now + SESSION_ABSOLUTE_TTL_MS).run();
    return true;
  } catch (error) {
    reportStoreFailure('session_tombstone_d1', error);
    return false;
  }
}

async function deleteD1Session(env, tokenHash) {
  const database = sessionDatabase(env);
  if (!database) return true;
  try {
    await database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(tokenHash)
      .run();
    return true;
  } catch (error) {
    reportStoreFailure('session_delete_d1', error);
    return false;
  }
}

async function writeLegacyKvSession(env, token, session) {
  if (!env || !env.YC_KV || typeof env.YC_KV.put !== 'function') return false;
  try {
    await env.YC_KV.put('sess:' + token, JSON.stringify({
      u: session.u,
      role: session.role,
      ...(session.provider ? { provider: session.provider } : {}),
      issuedAt: session.issuedAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    }), { expirationTtl: LEGACY_KV_TTL_SECONDS });
    return true;
  } catch (error) {
    return false;
  }
}

async function deleteLegacyKvSession(env, token) {
  if (!env || !env.YC_KV || typeof env.YC_KV.delete !== 'function') return true;
  try {
    await env.YC_KV.delete('sess:' + token);
    return true;
  } catch (error) {
    return false;
  }
}

async function readLegacyKvSession(env, token) {
  if (!env || !env.YC_KV || typeof env.YC_KV.get !== 'function') return null;
  try {
    const raw = await env.YC_KV.get('sess:' + token);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function normalizedSession(row) {
  return {
    u: String(row.username || ''),
    role: String(row.role || ''),
    provider: row.provider == null ? null : String(row.provider),
    issuedAt: Number(row.issued_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    accountRevokedBefore: row.account_revoked_before == null
      ? null
      : Number(row.account_revoked_before),
  };
}

function validRole(role) {
  return role === 'admin' || role === 'guest';
}

async function revokeToken(env, token, tokenHash, now = Date.now()) {
  // Write the authoritative tombstone before deleting either compatibility
  // copy. Otherwise an eventually-consistent KV read could resurrect a session
  // immediately after logout while legacy sessions are being lazily migrated.
  const tombstoned = await tombstoneD1Session(env, tokenHash, now);
  const [d1Deleted, kvDeleted] = await Promise.all([
    tombstoned ? deleteD1Session(env, tokenHash) : false,
    deleteLegacyKvSession(env, token),
  ]);
  return tombstoned && d1Deleted && kvDeleted;
}

export async function getSession(request, env, options = {}) {
  const token = bearerToken(request);
  if (!token) return null;
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  const tokenHash = await sha256Hex(token);
  const stored = await readD1Session(env, tokenHash);

  if (sessionDatabase(env) && !stored.available) {
    throw new AuthStoreUnavailableError('session_read_d1');
  }

  if (stored.revoked) {
    await deleteLegacyKvSession(env, token);
    return null;
  }

  if (stored.row) {
    const session = normalizedSession(stored.row);
    const malformed = !session.u || !validRole(session.role) ||
      !Number.isFinite(session.issuedAt) || !Number.isFinite(session.lastSeenAt) ||
      !Number.isFinite(session.expiresAt) || !Number.isFinite(session.absoluteExpiresAt);
    const revokedProvider = session.provider === 'google-admin';
    const accountRevoked = Number.isFinite(session.accountRevokedBefore) &&
      session.issuedAt <= session.accountRevokedBefore;
    const expired = session.expiresAt <= now || session.absoluteExpiresAt <= now;
    if (malformed || revokedProvider || accountRevoked || expired) {
      await revokeToken(env, token, tokenHash);
      return null;
    }

    if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS ||
        session.expiresAt - now <= SESSION_REFRESH_WINDOW_MS) {
      const previousExpiresAt = session.expiresAt;
      const refreshedExpiresAt = Math.min(now + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt);
      if (refreshedExpiresAt > previousExpiresAt) {
        const refreshed = {
          ...session,
          lastSeenAt: now,
          expiresAt: refreshedExpiresAt,
          previousExpiresAt,
        };
        if (await refreshD1Session(env, tokenHash, refreshed)) {
          session.lastSeenAt = refreshed.lastSeenAt;
          session.expiresAt = refreshed.expiresAt;
          // One-release compatibility copy makes an emergency Worker rollback
          // non-destructive while D1 becomes authoritative.
          await writeLegacyKvSession(env, token, session);
        }
      }
    }
    return { token, ...session, store: 'd1' };
  }

  const legacy = await readLegacyKvSession(env, token);
  if (!legacy) return null;
  if (legacy.provider === 'google-admin' || !legacy.u || !validRole(legacy.role)) {
    await revokeToken(env, token, tokenHash);
    return null;
  }

  const legacyIssuedAt = Number.isFinite(Number(legacy.issuedAt)) ? Number(legacy.issuedAt) : null;
  const accountRevokedBefore = await readAccountRevocation(env, legacy.u);
  if (Number.isFinite(accountRevokedBefore) &&
      (legacyIssuedAt == null || legacyIssuedAt <= accountRevokedBefore)) {
    await revokeToken(env, token, tokenHash, now);
    return null;
  }
  const issuedAt = legacyIssuedAt == null ? now : legacyIssuedAt;
  const absoluteExpiresAt = Number.isFinite(Number(legacy.absoluteExpiresAt))
    ? Number(legacy.absoluteExpiresAt)
    : issuedAt + SESSION_ABSOLUTE_TTL_MS;
  const expiresAt = Math.min(
    Number.isFinite(Number(legacy.expiresAt)) ? Number(legacy.expiresAt) : now + SESSION_IDLE_TTL_MS,
    absoluteExpiresAt,
  );
  if (expiresAt <= now || absoluteExpiresAt <= now) {
    await revokeToken(env, token, tokenHash);
    return null;
  }

  const migrated = {
    u: String(legacy.u),
    role: String(legacy.role),
    provider: legacy.provider || null,
    issuedAt,
    lastSeenAt: now,
    expiresAt,
    absoluteExpiresAt,
  };
  const migratedToD1 = await writeD1Session(env, tokenHash, migrated);
  if (sessionDatabase(env) && !migratedToD1) {
    throw new AuthStoreUnavailableError('session_migrate_d1');
  }
  return { token, ...migrated, store: migratedToD1 ? 'd1-migrated' : 'kv' };
}

export async function newSession(env, username, role, details = {}, options = {}) {
  if (!username || !validRole(role)) throw new Error('invalid_session_identity');
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  const session = {
    u: String(username),
    role,
    provider: details.provider || null,
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_IDLE_TTL_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TTL_MS,
  };
  const tokenHash = await sha256Hex(token);
  const d1Stored = await writeD1Session(env, tokenHash, session);
  const kvStored = await writeLegacyKvSession(env, token, session);
  // Once the D1 binding exists, it is the immediate-consistency authority.
  // KV-only creation is allowed solely for installations that have not bound
  // D1 at all; deployments with D1 must apply the additive migration first.
  if ((sessionDatabase(env) && !d1Stored) || (!d1Stored && !kvStored)) {
    throw new AuthStoreUnavailableError('session_create');
  }
  return token;
}

export async function revokeSession(env, token) {
  if (!TOKEN_PATTERN.test(String(token || ''))) return true;
  const normalized = String(token).toLowerCase();
  const tokenHash = await sha256Hex(normalized);
  return revokeToken(env, normalized, tokenHash);
}

async function readAccountRevocation(env, username) {
  const database = sessionDatabase(env);
  if (!database || !username) return null;
  try {
    const row = await database.prepare(
      'SELECT revoked_before FROM auth_account_revocations WHERE username = ?'
    ).bind(String(username)).first();
    return row && Number.isFinite(Number(row.revoked_before))
      ? Number(row.revoked_before)
      : null;
  } catch (error) {
    reportStoreFailure('account_revocation_read_d1', error);
    throw new AuthStoreUnavailableError('account_revocation_read_d1');
  }
}

export async function revokeUserSessions(env, username, options = {}) {
  const database = sessionDatabase(env);
  if (!database || !username) return false;
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  const expiresAt = now + SESSION_ABSOLUTE_TTL_MS;
  try {
    const statements = [
      database.prepare(`
        INSERT INTO auth_account_revocations (username, revoked_before, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(username) DO UPDATE SET
          revoked_before = MAX(auth_account_revocations.revoked_before, excluded.revoked_before),
          expires_at = MAX(auth_account_revocations.expires_at, excluded.expires_at)
      `).bind(String(username), now, expiresAt),
      database.prepare(`
        INSERT INTO auth_session_revocations (token_hash, revoked_at, expires_at)
        SELECT token_hash, ?, ?
        FROM auth_sessions
        WHERE username = ?
        ON CONFLICT(token_hash) DO UPDATE SET
          revoked_at = excluded.revoked_at,
          expires_at = MAX(auth_session_revocations.expires_at, excluded.expires_at)
      `).bind(now, expiresAt, String(username)),
      database.prepare('DELETE FROM auth_sessions WHERE username = ?')
        .bind(String(username)),
    ];
    if (typeof database.batch === 'function') await database.batch(statements);
    else for (const statement of statements) await statement.run();
    return true;
  } catch (error) {
    reportStoreFailure('account_revoke_d1', error);
    return false;
  }
}

export async function sessionStoreHealth(env) {
  const database = sessionDatabase(env);
  if (!database) return false;
  try {
    const row = await database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'auth_sessions',
          'auth_session_revocations',
          'auth_account_revocations'
        )
    `).first();
    return Number(row && row.count || 0) === 3;
  } catch (error) {
    reportStoreFailure('session_health_d1', error);
    return false;
  }
}

export async function authRateLimitHealth(env) {
  const database = sessionDatabase(env);
  if (!database) return false;
  try {
    const row = await database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'auth_rate_limits'
    `).first();
    return Number(row && row.count || 0) === 1;
  } catch (error) {
    reportStoreFailure('rate_limit_health_d1', error);
    return false;
  }
}

export async function cleanupAuthState(env, options = {}) {
  const database = sessionDatabase(env);
  if (!database) return false;
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  try {
    await database.prepare(
      'DELETE FROM auth_sessions WHERE expires_at <= ? OR absolute_expires_at <= ?'
    ).bind(now, now).run();
    await database.prepare(
      'DELETE FROM auth_session_revocations WHERE expires_at <= ?'
    ).bind(now).run();
    await database.prepare(
      'DELETE FROM auth_account_revocations WHERE expires_at <= ?'
    ).bind(now).run();
    await database.prepare(
      'DELETE FROM auth_rate_limits WHERE expires_at <= ?'
    ).bind(now).run();
    return true;
  } catch (error) {
    reportStoreFailure('cleanup_d1', error);
    return false;
  }
}
