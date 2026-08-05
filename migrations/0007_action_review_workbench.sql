PRAGMA foreign_keys = ON;

-- Corporate-action discovery is deliberately separate from accounting. A
-- provider signal can open a review item, but only an administrator-supplied
-- quantity transformation/cash change may enter the existing Pending/Confirm
-- ledger workflow.
CREATE TABLE IF NOT EXISTS ledger_corporate_action_candidates (
  candidate_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  source_record_id TEXT NOT NULL UNIQUE
    REFERENCES ledger_source_records(source_record_id),
  source_system TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  security_name TEXT NOT NULL,
  action_date TEXT NOT NULL,
  record_date TEXT,
  action_type_hint TEXT NOT NULL
    CHECK (action_type_hint IN ('SPLIT', 'SPINOFF', 'RENAME', 'MERGER', 'UNKNOWN')),
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (status IN ('PENDING_VERIFICATION', 'CONVERTED', 'DISMISSED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  detected_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  converted_pending_id TEXT UNIQUE REFERENCES ledger_pending(pending_id),
  resolved_by TEXT,
  resolved_at INTEGER,
  resolution_note TEXT,
  UNIQUE (portfolio_id, source_system, source_event_id),
  CHECK (
    (status = 'PENDING_VERIFICATION' AND converted_pending_id IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (status = 'CONVERTED' AND converted_pending_id IS NOT NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'DISMISSED' AND converted_pending_id IS NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_corporate_action_candidates_inbox
  ON ledger_corporate_action_candidates(
    portfolio_id, status, action_date, ticker, detected_at
  );

-- Provider revisions/cancellations are observations, never in-place rewrites
-- of the first immutable source fact.
CREATE TABLE IF NOT EXISTS ledger_candidate_observations (
  observation_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('DIVIDEND', 'CORPORATE_ACTION')),
  candidate_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  observed_at INTEGER NOT NULL,
  UNIQUE (candidate_type, candidate_id, content_sha256)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_candidate_observations_history
  ON ledger_candidate_observations(
    portfolio_id, candidate_type, candidate_id, observed_at DESC
  );

-- Every enter/ignore/reopen/amend choice is append-only. Candidate status is
-- only the fast current view; this table is the durable operator history.
CREATE TABLE IF NOT EXISTS ledger_candidate_resolutions (
  resolution_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('DIVIDEND', 'CORPORATE_ACTION')),
  candidate_id TEXT NOT NULL,
  resolution_action TEXT NOT NULL
    CHECK (resolution_action IN ('ENTER', 'IGNORE', 'REOPEN', 'AMEND')),
  candidate_version INTEGER NOT NULL CHECK (candidate_version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  pending_id TEXT REFERENCES ledger_pending(pending_id),
  actor_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_candidate_resolutions_history
  ON ledger_candidate_resolutions(
    portfolio_id, candidate_type, candidate_id, created_at DESC
  );

-- Backfill coverage is stored independently from the ledger revision. A first
-- successful run covers the entire positive-holding history; later runs use an
-- overlapping incremental window. PARTIAL is explicit and never presented as
-- complete coverage.
CREATE TABLE IF NOT EXISTS ledger_action_scan_state (
  portfolio_id TEXT PRIMARY KEY REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0),
  coverage_from TEXT,
  scanned_through TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('NOT_STARTED', 'BACKFILLING', 'COMPLETE', 'PARTIAL')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  checked_holdings INTEGER NOT NULL DEFAULT 0 CHECK (checked_holdings >= 0),
  failed_holdings INTEGER NOT NULL DEFAULT 0 CHECK (failed_holdings >= 0),
  source_coverage_json TEXT NOT NULL CHECK (json_valid(source_coverage_json)),
  last_error_json TEXT NOT NULL CHECK (json_valid(last_error_json)),
  updated_at INTEGER NOT NULL
) STRICT;
