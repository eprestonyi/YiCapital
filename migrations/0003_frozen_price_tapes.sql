PRAGMA foreign_keys = ON;

-- A historical NAV replay must never share mutable quote rows with the live
-- counter-price path. One immutable manifest is frozen per ledger revision;
-- every replay batch reads the exact same raw-close rows and trading calendar.
CREATE TABLE IF NOT EXISTS ledger_price_tapes (
  price_tape_id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES ledger_portfolios(portfolio_id),
  ledger_revision INTEGER NOT NULL CHECK (ledger_revision >= 0),
  tape_from TEXT NOT NULL,
  tape_through TEXT NOT NULL,
  calendar_from TEXT NOT NULL,
  required_tickers_json TEXT NOT NULL CHECK (json_valid(required_tickers_json)),
  calendar_dates_json TEXT NOT NULL CHECK (json_valid(calendar_dates_json)),
  price_source TEXT NOT NULL,
  calendar_source TEXT NOT NULL,
  calendar_source_ref TEXT,
  parent_price_tape_id TEXT REFERENCES ledger_price_tapes(price_tape_id),
  inherited_through TEXT,
  price_basis TEXT NOT NULL CHECK (price_basis = 'raw_close'),
  adjusted INTEGER NOT NULL CHECK (adjusted = 0),
  price_tape_hash TEXT NOT NULL,
  price_row_count INTEGER NOT NULL CHECK (price_row_count >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (portfolio_id, ledger_revision)
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_price_tape_rows (
  price_tape_id TEXT NOT NULL REFERENCES ledger_price_tapes(price_tape_id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  price_date TEXT NOT NULL,
  price_micros INTEGER NOT NULL CHECK (price_micros > 0),
  source TEXT NOT NULL,
  source_ref TEXT,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (price_tape_id, ticker, price_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ledger_price_tape_revision
  ON ledger_price_tapes(portfolio_id, ledger_revision);

CREATE INDEX IF NOT EXISTS idx_ledger_price_tape_rows_date
  ON ledger_price_tape_rows(price_tape_id, price_date, ticker);
