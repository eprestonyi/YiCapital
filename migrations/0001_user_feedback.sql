CREATE TABLE IF NOT EXISTS feedback_entries (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'user'
    CHECK(source IN ('user', 'monitor', 'agent')),
  actor_type TEXT NOT NULL DEFAULT 'anonymous'
    CHECK(actor_type IN ('anonymous', 'user', 'deleted_user')),
  username TEXT,
  category TEXT NOT NULL
    CHECK(category IN (
      'bug', 'content', 'data', 'ux',
      'accessibility', 'performance', 'feature', 'other'
    )),
  rating INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 5),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 5 AND 2000),
  page_path TEXT NOT NULL,
  page_title TEXT,
  locale TEXT NOT NULL
    CHECK(locale IN ('zh-Hant', 'zh-Hans', 'en')),
  release_id TEXT,
  device_class TEXT
    CHECK(device_class IS NULL OR device_class IN ('mobile', 'tablet', 'desktop')),
  browser_family TEXT,
  viewport_width INTEGER,
  viewport_height INTEGER,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK(status IN (
      'new', 'triaged', 'planned', 'in_progress',
      'resolved', 'dismissed', 'duplicate'
    )),
  priority TEXT
    CHECK(priority IS NULL OR priority IN ('p0', 'p1', 'p2', 'p3')),
  admin_note TEXT NOT NULL DEFAULT '',
  linked_issue TEXT NOT NULL DEFAULT '',
  linked_pr TEXT NOT NULL DEFAULT '',
  resolved_release TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_status_time
  ON feedback_entries(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_category_time
  ON feedback_entries(category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_page_time
  ON feedback_entries(page_path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_release_time
  ON feedback_entries(release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback_changes (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by_type TEXT NOT NULL
    CHECK(changed_by_type IN ('system', 'admin', 'agent')),
  changed_by_ref TEXT,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
  note TEXT,
  FOREIGN KEY(feedback_id) REFERENCES feedback_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_changes_entry_time
  ON feedback_changes(feedback_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS feedback_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_reset
  ON feedback_rate_limits(reset_at);
