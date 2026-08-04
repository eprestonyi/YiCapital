PRAGMA foreign_keys = ON;

-- Authentication session state must be immediately readable after login and
-- immediately revocable after logout. Workers KV remains only as a temporary
-- rollback/migration copy because its cross-location reads are eventually
-- consistent.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
  provider TEXT,
  issued_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  CHECK (last_seen_at >= issued_at),
  CHECK (expires_at > issued_at),
  CHECK (absolute_expires_at >= expires_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
  ON auth_sessions(expires_at, absolute_expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_username
  ON auth_sessions(username);

-- Revocation tombstones prevent a stale legacy KV copy from resurrecting a
-- session after logout during the one-release lazy-migration window.
CREATE TABLE IF NOT EXISTS auth_session_revocations (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  revoked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > revoked_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_session_revocations_expiry
  ON auth_session_revocations(expires_at);

-- Password changes, disables and account deletion invalidate every current
-- session, including a legacy KV session not yet seen by D1.
CREATE TABLE IF NOT EXISTS auth_account_revocations (
  username TEXT PRIMARY KEY,
  revoked_before INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > revoked_before)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_account_revocations_expiry
  ON auth_account_revocations(expires_at);

-- Atomic counters avoid Workers KV's one-write-per-second limit on a hot key.
-- No raw IP address is stored; bucket_key contains only an action, a SHA-256
-- identity digest and the fixed window number.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_expiry
  ON auth_rate_limits(expires_at);
