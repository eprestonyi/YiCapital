PRAGMA foreign_keys = ON;

-- Market-data providers can tell us that a cash dividend exists, but they are
-- not the accounting authority for the amount actually received by the
-- broker.  This inbox stores the immutable detection fact with a deliberately
-- NULL amount.  An administrator later enters the broker-settled Amount and
-- converts the candidate into the existing Pending/Confirm workflow.
CREATE TABLE IF NOT EXISTS ledger_dividend_candidates (
  candidate_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  source_record_id TEXT NOT NULL UNIQUE
    REFERENCES ledger_source_records(source_record_id),
  source_system TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  security_name TEXT NOT NULL,
  ex_date TEXT,
  record_date TEXT,
  pay_date TEXT,
  -- A detected candidate must never contain a guessed provider amount.
  amount_minor INTEGER CHECK (amount_minor IS NULL),
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

CREATE INDEX IF NOT EXISTS idx_ledger_dividend_candidates_inbox
  ON ledger_dividend_candidates(portfolio_id, status, pay_date, ex_date, detected_at);

