import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GoogleIdTokenInvalidError,
  GoogleJwksUnavailableError,
  verifyGoogleIdToken,
} from '../worker/google-id-token.js';

const encoder = new TextEncoder();
const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function base64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonSegment(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

async function keyFixture(kid) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function signToken(fixture, payload, header = {}) {
  const encodedHeader = jsonSegment({ alg: 'RS256', typ: 'JWT', kid: fixture.jwk.kid, ...header });
  const encodedPayload = jsonSegment(payload);
  const signed = encodedHeader + '.' + encodedPayload;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    fixture.pair.privateKey,
    encoder.encode(signed)
  );
  return signed + '.' + base64Url(signature);
}

function claims(nowSeconds, overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: nowSeconds + 600,
    sub: 'google-subject-123',
    email: 'Investor@Example.com',
    email_verified: true,
    name: 'Investor',
    ...overrides,
  };
}

function jwksResponse(keys, cacheControl = 'public, max-age=3600') {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
  });
}

test('verifies RS256 signature and required Google claims, then reuses the cache', async () => {
  const nowMs = 1_800_000_000_000;
  const fixture = await keyFixture('valid-key');
  const token = await signToken(fixture, claims(Math.floor(nowMs / 1000)));
  let fetches = 0;
  const options = {
    now: () => nowMs,
    jwksUrl: 'https://keys.test/valid',
    fetch: async (url, init) => {
      fetches += 1;
      assert.equal(url, 'https://keys.test/valid');
      assert.equal(init.signal.aborted, false);
      return jwksResponse([fixture.jwk]);
    },
  };

  const verified = await verifyGoogleIdToken(token, CLIENT_ID, options);
  assert.equal(verified.sub, 'google-subject-123');
  assert.equal(verified.email, 'investor@example.com');
  assert.equal(verified.email_verified, true);
  assert.equal(verified.name, 'Investor');
  await verifyGoogleIdToken(token, [CLIENT_ID, 'another-client'], options);
  assert.equal(fetches, 1);
});

test('honors Cache-Control max-age and Age', async () => {
  let nowMs = 1_800_100_000_000;
  const fixture = await keyFixture('expiring-key');
  const token = await signToken(fixture, claims(Math.floor(nowMs / 1000)));
  let fetches = 0;
  const options = {
    now: () => nowMs,
    jwksUrl: 'https://keys.test/expiration',
    fetch: async () => {
      fetches += 1;
      const response = jwksResponse([fixture.jwk], 'public, max-age=3');
      response.headers.set('Age', '1');
      return response;
    },
  };

  await verifyGoogleIdToken(token, CLIENT_ID, options);
  nowMs += 1_999;
  await verifyGoogleIdToken(token, CLIENT_ID, options);
  assert.equal(fetches, 1);
  nowMs += 2;
  await verifyGoogleIdToken(token, CLIENT_ID, options);
  assert.equal(fetches, 2);
});

test('forces one JWKS refresh when a fresh cache does not contain the token kid', async () => {
  const nowMs = 1_800_200_000_000;
  const oldFixture = await keyFixture('old-key');
  const newFixture = await keyFixture('new-key');
  const oldToken = await signToken(oldFixture, claims(Math.floor(nowMs / 1000)));
  const newToken = await signToken(newFixture, claims(Math.floor(nowMs / 1000), { sub: 'new-subject' }));
  let fetches = 0;
  const options = {
    now: () => nowMs,
    jwksUrl: 'https://keys.test/rotation',
    fetch: async () => {
      fetches += 1;
      return jwksResponse(fetches === 1 ? [oldFixture.jwk] : [oldFixture.jwk, newFixture.jwk]);
    },
  };

  await verifyGoogleIdToken(oldToken, CLIENT_ID, options);
  const verified = await verifyGoogleIdToken(newToken, CLIENT_ID, options);
  assert.equal(verified.sub, 'new-subject');
  assert.equal(fetches, 2);
});

test('rejects an unknown kid after a forced refresh as an invalid token', async () => {
  const nowMs = 1_800_300_000_000;
  const known = await keyFixture('known-key');
  const unknown = await keyFixture('unknown-key');
  const knownToken = await signToken(known, claims(Math.floor(nowMs / 1000)));
  const unknownToken = await signToken(unknown, claims(Math.floor(nowMs / 1000)));
  let fetches = 0;
  const options = {
    now: () => nowMs,
    jwksUrl: 'https://keys.test/unknown',
    fetch: async () => {
      fetches += 1;
      return jwksResponse([known.jwk]);
    },
  };

  await verifyGoogleIdToken(knownToken, CLIENT_ID, options);
  await assert.rejects(
    verifyGoogleIdToken(unknownToken, CLIENT_ID, options),
    error => error instanceof GoogleIdTokenInvalidError && error.status === 401
  );
  assert.equal(fetches, 2);
});

test('rejects a token whose signature does not match the selected key', async () => {
  const nowMs = 1_800_400_000_000;
  const signer = await keyFixture('shared-kid');
  const advertised = await keyFixture('shared-kid');
  const token = await signToken(signer, claims(Math.floor(nowMs / 1000)));

  await assert.rejects(
    verifyGoogleIdToken(token, CLIENT_ID, {
      now: () => nowMs,
      jwksUrl: 'https://keys.test/bad-signature',
      fetch: async () => jwksResponse([advertised.jwk]),
    }),
    error => error instanceof GoogleIdTokenInvalidError && error.code === 'GOOGLE_ID_TOKEN_INVALID'
  );
});

test('rejects unsupported JOSE headers before fetching keys', async () => {
  const nowMs = 1_800_500_000_000;
  const fixture = await keyFixture('header-key');
  const token = await signToken(fixture, claims(Math.floor(nowMs / 1000)), { alg: 'HS256' });
  let fetched = false;
  await assert.rejects(
    verifyGoogleIdToken(token, CLIENT_ID, {
      now: () => nowMs,
      jwksUrl: 'https://keys.test/header',
      fetch: async () => { fetched = true; return jwksResponse([fixture.jwk]); },
    }),
    GoogleIdTokenInvalidError
  );
  assert.equal(fetched, false);
});

test('validates aud, iss, exp, sub, email_verified, and email claims', async t => {
  const nowMs = 1_800_600_000_000;
  const nowSeconds = Math.floor(nowMs / 1000);
  const fixture = await keyFixture('claims-key');
  const cases = [
    ['audience', { aud: 'wrong-client.apps.googleusercontent.com' }],
    ['issuer', { iss: 'https://attacker.example' }],
    ['expiration', { exp: nowSeconds - 61 }],
    ['subject', { sub: '' }],
    ['verified email', { email_verified: false }],
    ['email', { email: 'not-an-email' }],
  ];
  const options = {
    now: () => nowMs,
    jwksUrl: 'https://keys.test/claims',
    fetch: async () => jwksResponse([fixture.jwk]),
  };

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const token = await signToken(fixture, claims(nowSeconds, overrides));
      await assert.rejects(
        verifyGoogleIdToken(token, CLIENT_ID, options),
        error => error instanceof GoogleIdTokenInvalidError && error.status === 401
      );
    });
  }
});

test('classifies JWKS network, HTTP, and payload failures as temporary upstream errors', async t => {
  const nowMs = 1_800_700_000_000;
  const fixture = await keyFixture('upstream-key');
  const token = await signToken(fixture, claims(Math.floor(nowMs / 1000)));
  const cases = [
    ['network', async () => { throw new TypeError('network unavailable'); }],
    ['HTTP', async () => new Response('unavailable', { status: 503 })],
    ['JSON', async () => new Response('{', { status: 200 })],
    ['JWKS shape', async () => jwksResponse([])],
  ];

  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyGoogleIdToken(token, CLIENT_ID, {
          now: () => nowMs,
          jwksUrl: 'https://keys.test/upstream-' + name,
          fetch: fetchImpl,
        }),
        error => error instanceof GoogleJwksUnavailableError
          && error.code === 'GOOGLE_JWKS_UNAVAILABLE'
          && error.status === 503
      );
    });
  }
});

test('aborts a stalled JWKS request at the configured deadline', async () => {
  const nowMs = 1_800_800_000_000;
  const fixture = await keyFixture('timeout-key');
  const token = await signToken(fixture, claims(Math.floor(nowMs / 1000)));
  let observedAbort = false;
  const fetchImpl = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      observedAbort = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

  await assert.rejects(
    verifyGoogleIdToken(token, CLIENT_ID, {
      now: () => nowMs,
      jwksUrl: 'https://keys.test/timeout',
      fetch: fetchImpl,
      timeoutMs: 20,
    }),
    GoogleJwksUnavailableError
  );
  assert.equal(observedAbort, true);
});
