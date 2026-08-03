PRAGMA foreign_keys = ON;

-- Yi Capital portfolio ledger v1.
-- D1 is the source of truth. KV is a materialized read cache for the existing
-- public /api/nav/* contract and is rebuilt from confirmed events.

CREATE TABLE IF NOT EXISTS ledger_portfolios (
  portfolio_id TEXT PRIMARY KEY CHECK (portfolio_id IN ('us', 'hk', 'a')),
  display_name TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('us', 'hk', 'a')),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'HKD', 'CNY')),
  ledger_revision INTEGER NOT NULL DEFAULT 0 CHECK (ledger_revision >= 0),
  template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO ledger_portfolios (
  portfolio_id, display_name, market, currency, created_at, updated_at
) VALUES
  ('us', 'Yi Capital US', 'us', 'USD', unixepoch() * 1000, unixepoch() * 1000),
  ('hk', 'Yi Capital HK', 'hk', 'HKD', unixepoch() * 1000, unixepoch() * 1000),
  ('a', 'Yi Capital A', 'a', 'CNY', unixepoch() * 1000, unixepoch() * 1000);

-- Immutable payload received from brokers, custodians or market-data jobs.
-- A source record may create one Pending item but is never itself the ledger.
CREATE TABLE IF NOT EXISTS ledger_source_records (
  source_record_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  source_system TEXT NOT NULL,
  source_account TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  trade_date TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  content_sha256 TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (portfolio_id, source_system, source_account, source_event_id)
) STRICT;

-- Mutable review queue. Only this table may be edited in place.
CREATE TABLE IF NOT EXISTS ledger_pending (
  pending_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'BUY', 'SELL', 'DIVIDEND', 'CORPORATE_ACTION',
    'LIABILITY', 'CAPITAL', 'FUND_ACTION', 'REVERSAL'
  )),
  trade_date TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  source TEXT NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL', 'AUTOMATION', 'EXCEL', 'MIGRATION', 'LEGACY_API')),
  source_record_id TEXT REFERENCES ledger_source_records(source_record_id),
  source_ref TEXT,
  idempotency_key TEXT,
  import_id TEXT,
  lineage_id TEXT,
  base_event_id TEXT,
  base_event_version INTEGER,
  confirmed_event_id TEXT,
  review_note TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_pending_idempotency
  ON ledger_pending(portfolio_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_pending_queue
  ON ledger_pending(portfolio_id, status, trade_date, created_at);

-- Short-lived rows used inside D1 batch() to turn optimistic-lock misses into a
-- constraint error. Successful batches delete the guard before commit.
CREATE TABLE IF NOT EXISTS ledger_transaction_guards (
  guard_id TEXT PRIMARY KEY,
  pending_id TEXT NOT NULL,
  expected_pending_version INTEGER NOT NULL,
  portfolio_id TEXT NOT NULL,
  expected_ledger_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Confirmed events are append-only. Corrections use a new REVERSAL event and a
-- new corrected event; an existing confirmed row is never overwritten.
CREATE TABLE IF NOT EXISTS ledger_events (
  event_id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version > 0),
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'BUY', 'SELL', 'DIVIDEND', 'CORPORATE_ACTION',
    'LIABILITY', 'CAPITAL', 'FUND_ACTION', 'REVERSAL'
  )),
  trade_date TEXT NOT NULL,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'HKD', 'CNY')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  gross_amount_minor INTEGER,
  tax_amount_minor INTEGER,
  fee_amount_minor INTEGER,
  net_cash_minor INTEGER,
  source TEXT NOT NULL,
  source_ref TEXT,
  idempotency_key TEXT,
  supersedes_event_id TEXT REFERENCES ledger_events(event_id),
  reversal_of_event_id TEXT REFERENCES ledger_events(event_id),
  pending_id TEXT UNIQUE REFERENCES ledger_pending(pending_id),
  confirmed_by TEXT NOT NULL,
  confirm_reason TEXT NOT NULL DEFAULT '',
  confirmed_at INTEGER NOT NULL,
  UNIQUE (portfolio_id, ledger_revision),
  UNIQUE (portfolio_id, lineage_id, event_version)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_events_idempotency
  ON ledger_events(portfolio_id, source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_events_replay
  ON ledger_events(portfolio_id, trade_date, sequence_no, confirmed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_events_supersedes
  ON ledger_events(supersedes_event_id)
  WHERE supersedes_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_events_reversal
  ON ledger_events(reversal_of_event_id)
  WHERE reversal_of_event_id IS NOT NULL;

-- Append-only operator and system audit trail.
CREATE TABLE IF NOT EXISTS ledger_audit_log (
  audit_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ADMIN', 'SYSTEM', 'MIGRATION')),
  actor_ref TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_audit_target
  ON ledger_audit_log(portfolio_id, target_type, target_id, created_at);

-- Each workbook export has a server snapshot used for three-way merge.
CREATE TABLE IF NOT EXISTS ledger_exports (
  export_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL,
  layout_hash TEXT NOT NULL,
  sync_token_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_exports_portfolio
  ON ledger_exports(portfolio_id, ledger_revision, created_at);

-- Workbook imports are two-stage: PREVIEWED then CONFIRMED. A repeated file is
-- idempotent, and confirmation rechecks the portfolio revision.
CREATE TABLE IF NOT EXISTS ledger_imports (
  import_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  file_name TEXT NOT NULL,
  upload_sha256 TEXT NOT NULL,
  export_id TEXT REFERENCES ledger_exports(export_id),
  base_ledger_revision INTEGER NOT NULL CHECK (base_ledger_revision >= 0),
  status TEXT NOT NULL DEFAULT 'PREVIEWED'
    CHECK (status IN ('PREVIEWED', 'CONFIRMED', 'STALE', 'REJECTED')),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  UNIQUE (portfolio_id, upload_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_import_rows (
  operation_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES ledger_imports(import_id) ON DELETE CASCADE,
  sheet_name TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  operation TEXT NOT NULL CHECK (operation IN (
    'CREATE', 'UPDATE', 'NOOP', 'CONFLICT', 'ERROR',
    'IGNORED_DERIVED', 'MISSING_IN_EXCEL'
  )),
  event_id TEXT,
  base_version INTEGER,
  base_json TEXT CHECK (base_json IS NULL OR json_valid(base_json)),
  excel_json TEXT CHECK (excel_json IS NULL OR json_valid(excel_json)),
  current_json TEXT CHECK (current_json IS NULL OR json_valid(current_json)),
  diff_json TEXT CHECK (diff_json IS NULL OR json_valid(diff_json)),
  row_hash TEXT NOT NULL,
  error_text TEXT,
  UNIQUE (import_id, row_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_import_rows_batch
  ON ledger_import_rows(import_id, operation, row_number);

-- D1 commit and KV publication cannot be one distributed transaction. The
-- outbox makes snapshot publication retryable and observable.
CREATE TABLE IF NOT EXISTS ledger_outbox (
  outbox_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REBUILD_KV', 'REBUILD_EXCEL', 'RECALC_NAV')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE (portfolio_id, ledger_revision, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_outbox_ready
  ON ledger_outbox(status, available_at, created_at);

-- Optional historical projections. They are always rebuildable from the event
-- ledger plus price observations and never accept Excel writes.
CREATE TABLE IF NOT EXISTS ledger_prices (
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  ticker TEXT NOT NULL,
  price_date TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  price_micros INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'HKD', 'CNY')),
  source TEXT NOT NULL,
  source_ref TEXT,
  source_workbook_sha256 TEXT,
  source_row INTEGER,
  valuation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(valuation_json)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (portfolio_id, ticker, price_date)
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_nav_snapshots (
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  nav_date TEXT NOT NULL,
  ledger_revision INTEGER NOT NULL,
  cash_minor INTEGER NOT NULL,
  market_value_minor INTEGER NOT NULL,
  total_assets_minor INTEGER NOT NULL,
  liability_minor INTEGER NOT NULL,
  liability_asset_ratio_micros INTEGER,
  net_value_minor INTEGER NOT NULL,
  units_micros INTEGER NOT NULL,
  unit_nav_micros INTEGER,
  fund_action_adjustment_minor INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  source_ref TEXT,
  source_workbook_sha256 TEXT,
  source_row INTEGER,
  valuation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(valuation_json)),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  calculated_at INTEGER NOT NULL,
  PRIMARY KEY (portfolio_id, nav_date)
) STRICT;
