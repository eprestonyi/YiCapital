const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_JWKS_TIMEOUT_MS = 5_000;
const MAX_JWKS_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 64;
const MAX_TOKEN_BYTES = 16 * 1024;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const MAX_CACHE_SECONDS = 24 * 60 * 60;
const MAX_STALE_SECONDS = 48 * 60 * 60;
const PERSISTED_JWKS_CACHE_KEY = 'google:jwks:v1';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const jwksCache = new Map();
const jwksRequests = new Map();

export class GoogleIdTokenInvalidError extends Error {
  constructor(message = 'Google ID token is invalid') {
    super(message);
    this.name = 'GoogleIdTokenInvalidError';
    this.code = 'GOOGLE_ID_TOKEN_INVALID';
    this.status = 401;
  }
}

export class GoogleJwksUnavailableError extends Error {
  constructor(message = 'Google signing keys are temporarily unavailable') {
    super(message);
    this.name = 'GoogleJwksUnavailableError';
    this.code = 'GOOGLE_JWKS_UNAVAILABLE';
    this.status = 503;
  }
}

function invalid(message) {
  return new GoogleIdTokenInvalidError(message);
}

function unavailable() {
  return new GoogleJwksUnavailableError();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalid();
  }
  const padding = (4 - (value.length % 4)) % 4;
  let binary;
  try {
    binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  } catch (error) {
    throw invalid();
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(value) {
  try {
    const decoded = JSON.parse(textDecoder.decode(decodeBase64Url(value)));
    if (!isPlainObject(decoded)) throw invalid();
    return decoded;
  } catch (error) {
    if (error instanceof GoogleIdTokenInvalidError) throw error;
    throw invalid();
  }
}

function parseToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw invalid();

  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  if (header.alg !== 'RS256') throw invalid('Google ID token algorithm is invalid');
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) {
    throw invalid('Google ID token key identifier is invalid');
  }

  return {
    header,
    payload,
    signature: decodeBase64Url(parts[2]),
    signedBytes: textEncoder.encode(parts[0] + '.' + parts[1]),
  };
}

function cacheLifetimeMs(headers) {
  const cacheControl = String(headers && headers.get && headers.get('Cache-Control') || '');
  if (!cacheControl || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cacheControl)) return 0;
  const directives = new Map();
  for (const part of cacheControl.split(',')) {
    const match = part.trim().match(/^([\w-]+)(?:\s*=\s*"?(\d+)"?)?$/);
    if (match) directives.set(match[1].toLowerCase(), match[2]);
  }
  const rawMaxAge = directives.get('s-maxage') || directives.get('max-age');
  if (!rawMaxAge) return 0;
  const maxAge = Math.min(MAX_CACHE_SECONDS, Number(rawMaxAge));
  const age = Math.max(0, Number(headers.get('Age') || 0));
  if (!Number.isFinite(maxAge) || !Number.isFinite(age)) return 0;
  return Math.max(0, maxAge - age) * 1000;
}

function indexJwks(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.keys)
      || payload.keys.length === 0 || payload.keys.length > MAX_JWKS_KEYS) {
    throw unavailable();
  }
  const keys = new Map();
  for (const jwk of payload.keys) {
    if (!isPlainObject(jwk) || typeof jwk.kid !== 'string' || !jwk.kid || jwk.kid.length > 256) {
      throw unavailable();
    }
    if (keys.has(jwk.kid)) throw unavailable();
    keys.set(jwk.kid, jwk);
  }
  return keys;
}

async function loadPersistedJwks(url, keyCache, keyCacheKey, now) {
  if (!keyCache || typeof keyCache.get !== 'function') return null;
  let raw;
  try {
    raw = await keyCache.get(keyCacheKey);
  } catch (error) {
    return null;
  }
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (!isPlainObject(payload)
        || payload.version !== 1
        || payload.url !== url
        || !Array.isArray(payload.keys)
        || !Number.isFinite(payload.expiresAt)
        || !Number.isFinite(payload.staleUntil)
        || payload.staleUntil <= now()) {
      return null;
    }
    return {
      keys: indexJwks({ keys: payload.keys }),
      importedKeys: new Map(),
      expiresAt: payload.expiresAt,
      staleUntil: payload.staleUntil,
    };
  } catch (error) {
    return null;
  }
}

async function persistJwks(url, entry, keyCache, keyCacheKey, now) {
  if (!keyCache || typeof keyCache.put !== 'function' || entry.staleUntil <= now()) return;
  const ttl = Math.max(60, Math.ceil((entry.staleUntil - now()) / 1000));
  try {
    await keyCache.put(keyCacheKey, JSON.stringify({
      version: 1,
      url,
      keys: Array.from(entry.keys.values()),
      expiresAt: entry.expiresAt,
      staleUntil: entry.staleUntil,
    }), { expirationTtl: ttl });
  } catch (error) {
    // Persistent cache failures must never turn a valid Google login into an outage.
  }
}

async function fetchJwks(url, fetchImpl, now, timeoutMs, keyCache, keyCacheKey) {
  const existing = jwksRequests.get(url);
  if (existing) return existing;

  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let raw;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || !response.ok) throw unavailable();
      raw = await response.text();
    } catch (error) {
      if (error instanceof GoogleJwksUnavailableError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
    if (!raw || raw.length > MAX_JWKS_BYTES) throw unavailable();

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw unavailable();
    }
    const fetchedAt = now();
    const lifetimeMs = cacheLifetimeMs(response.headers);
    const entry = {
      keys: indexJwks(payload),
      importedKeys: new Map(),
      expiresAt: fetchedAt + lifetimeMs,
      staleUntil: fetchedAt + lifetimeMs + (lifetimeMs > 0 ? MAX_STALE_SECONDS * 1000 : 0),
    };
    jwksCache.set(url, entry);
    await persistJwks(url, entry, keyCache, keyCacheKey, now);
    return entry;
  })();

  jwksRequests.set(url, request);
  try {
    return await request;
  } finally {
    if (jwksRequests.get(url) === request) jwksRequests.delete(url);
  }
}

async function jwkForKid(kid, options) {
  const { jwksUrl, fetchImpl, now, timeoutMs, keyCache, keyCacheKey } = options;
  let entry = jwksCache.get(jwksUrl);
  if (!entry || entry.staleUntil <= now()) {
    entry = await loadPersistedJwks(jwksUrl, keyCache, keyCacheKey, now);
    if (entry) jwksCache.set(jwksUrl, entry);
  }
  const fresh = entry && entry.expiresAt > now();
  const stale = entry && entry.staleUntil > now() && entry.keys.has(kid) ? entry : null;

  try {
    if (!fresh) entry = await fetchJwks(jwksUrl, fetchImpl, now, timeoutMs, keyCache, keyCacheKey);
    else if (!entry.keys.has(kid)) {
      entry = await fetchJwks(jwksUrl, fetchImpl, now, timeoutMs, keyCache, keyCacheKey);
    }
  } catch (error) {
    if (error instanceof GoogleJwksUnavailableError && stale) entry = stale;
    else throw error;
  }

  const jwk = entry.keys.get(kid);
  if (!jwk) throw invalid('Google ID token signing key is unknown');
  return { entry, jwk };
}

async function importVerificationKey(entry, jwk) {
  const cached = entry.importedKeys.get(jwk.kid);
  if (cached) return cached;
  if (jwk.kty !== 'RSA'
      || (jwk.alg != null && jwk.alg !== 'RS256')
      || (jwk.use != null && jwk.use !== 'sig')
      || (jwk.key_ops != null && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))
      || typeof jwk.n !== 'string' || !jwk.n
      || typeof jwk.e !== 'string' || !jwk.e) {
    throw unavailable();
  }
  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
  } catch (error) {
    throw unavailable();
  }
  entry.importedKeys.set(jwk.kid, key);
  return key;
}

function expectedAudiences(expectedAudience) {
  const values = Array.isArray(expectedAudience) ? expectedAudience : [expectedAudience];
  const audiences = new Set(values.filter(value => typeof value === 'string' && value));
  if (audiences.size === 0) throw new TypeError('A Google OAuth client ID is required');
  return audiences;
}

function validateClaims(payload, audience, nowSeconds, clockSkewSeconds) {
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    throw invalid('Google ID token issuer is invalid');
  }
  const tokenAudiences = typeof payload.aud === 'string'
    ? [payload.aud]
    : (Array.isArray(payload.aud) && payload.aud.every(value => typeof value === 'string')
      ? payload.aud
      : []);
  if (!tokenAudiences.some(value => audience.has(value))) {
    throw invalid('Google ID token audience is invalid');
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
      || payload.exp <= nowSeconds - clockSkewSeconds) {
    throw invalid('Google ID token has expired');
  }
  if (payload.nbf != null && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)
      || payload.nbf > nowSeconds + clockSkewSeconds)) {
    throw invalid('Google ID token is not active');
  }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) {
    throw invalid('Google ID token subject is invalid');
  }
  if (payload.email_verified !== true) throw invalid('Google email is not verified');
  if (typeof payload.email !== 'string') throw invalid('Google email is invalid');
  const email = payload.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || /\s/.test(email)
      || !/^[^@]+@[^@]+$/.test(email)) {
    throw invalid('Google email is invalid');
  }
  return email;
}

/** Keep a verified Google signing-key set ready before the next user signs in. */
export async function warmGoogleSigningKeys(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw unavailable();
  const jwksUrl = options.jwksUrl || GOOGLE_JWKS_URL;
  const timeoutMs = options.timeoutMs == null ? GOOGLE_JWKS_TIMEOUT_MS : Number(options.timeoutMs);
  const keyCache = options.keyCache;
  const keyCacheKey = options.keyCacheKey || PERSISTED_JWKS_CACHE_KEY;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Google signing-key warmup options are invalid');
  }

  let entry = jwksCache.get(jwksUrl);
  if (!entry || entry.staleUntil <= now()) {
    entry = await loadPersistedJwks(jwksUrl, keyCache, keyCacheKey, now);
    if (entry) jwksCache.set(jwksUrl, entry);
  }
  if (entry && entry.expiresAt > now()) {
    await persistJwks(jwksUrl, entry, keyCache, keyCacheKey, now);
    return true;
  }
  try {
    await fetchJwks(jwksUrl, fetchImpl, now, timeoutMs, keyCache, keyCacheKey);
    return true;
  } catch (error) {
    if (error instanceof GoogleJwksUnavailableError && entry && entry.staleUntil > now()) return true;
    throw error;
  }
}

/**
 * Verify a Google Identity Services ID token locally using Google's rotating JWKS.
 *
 * Invalid credentials throw GoogleIdTokenInvalidError (HTTP 401). A temporary
 * failure to obtain or import Google's signing keys throws
 * GoogleJwksUnavailableError (HTTP 503).
 */
export async function verifyGoogleIdToken(token, expectedAudience, options = {}) {
  const parsed = parseToken(token);
  const audience = expectedAudiences(expectedAudience);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw unavailable();
  const jwksUrl = options.jwksUrl || GOOGLE_JWKS_URL;
  const timeoutMs = options.timeoutMs == null ? GOOGLE_JWKS_TIMEOUT_MS : Number(options.timeoutMs);
  const keyCache = options.keyCache;
  const keyCacheKey = options.keyCacheKey || PERSISTED_JWKS_CACHE_KEY;
  const clockSkewSeconds = options.clockSkewSeconds == null
    ? DEFAULT_CLOCK_SKEW_SECONDS
    : Number(options.clockSkewSeconds);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new TypeError('Google token verifier options are invalid');
  }

  const { entry, jwk } = await jwkForKid(parsed.header.kid, {
    jwksUrl,
    fetchImpl,
    now,
    timeoutMs,
    keyCache,
    keyCacheKey,
  });
  const key = await importVerificationKey(entry, jwk);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      parsed.signature,
      parsed.signedBytes
    );
  } catch (error) {
    throw invalid();
  }
  if (!signatureValid) throw invalid('Google ID token signature is invalid');

  const email = validateClaims(
    parsed.payload,
    audience,
    Math.floor(now() / 1000),
    clockSkewSeconds
  );
  return Object.freeze({
    ...parsed.payload,
    sub: parsed.payload.sub,
    email,
    email_verified: true,
  });
}
