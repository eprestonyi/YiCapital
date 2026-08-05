PRAGMA foreign_keys = ON;

-- Public portfolio payloads are mutable derived projections, not accounting
-- facts. Keep one atomic D1 row per portfolio so minute-level NAV publication
-- does not depend on Cloudflare KV's low daily write allowance. KV remains a
-- read-only legacy/disaster-recovery fallback during migration.
CREATE TABLE IF NOT EXISTS ledger_public_snapshots (
  portfolio_id TEXT PRIMARY KEY REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0),
  snapshot_id TEXT NOT NULL,
  as_of_date TEXT,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  status_json TEXT CHECK (status_json IS NULL OR json_valid(status_json)),
  generated_at INTEGER NOT NULL,
  status_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- The latest attempt is intentionally separate from the large last-known-good
-- payload. A failed refresh can mark that payload stale without rewriting it,
-- and a first attempt can be recorded before any D1 public release exists.
CREATE TABLE IF NOT EXISTS ledger_public_attempts (
  portfolio_id TEXT PRIMARY KEY REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0),
  status_json TEXT NOT NULL CHECK (json_valid(status_json)),
  status_sha256 TEXT NOT NULL CHECK (length(status_sha256) = 64),
  status_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Confirmed events, prices and NAV rows remain the accounting facts. This row
-- is their current materialized read projection, replacing the legacy
-- ledger:{portfolio} KV object without changing the REBUILD_KV outbox name.
CREATE TABLE IF NOT EXISTS ledger_materialized_projections (
  portfolio_id TEXT PRIMARY KEY REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  projection_sha256 TEXT NOT NULL CHECK (length(projection_sha256) = 64),
  generated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
