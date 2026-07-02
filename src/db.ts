import Database from "better-sqlite3";

// SQLite keeps this demo runnable with zero infrastructure. In production this
// layer maps to Postgres: same schema, same write-first durability guarantee.
// WAL mode gives us crash-safe durability for the "we can't lose feedback" requirement.

export function createDb(path = process.env.DB_PATH ?? "feedback.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    -- Raw submissions. Written FIRST, before any processing. This table is the
    -- source of truth: everything downstream can be rebuilt from it.
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      segment TEXT NOT NULL CHECK (segment IN ('enterprise','mid-market','smb')),
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Processing queue. One job per submission. In production this is Kafka or
    -- a Redis-backed queue; a table makes the retry/DLQ mechanics visible and
    -- keeps the demo dependency-free. Same pattern either way.
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','processing','done','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    -- Per-submission LLM extractions. Noisy by design; the aggregation pass
    -- normalizes them.
    CREATE TABLE IF NOT EXISTS extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
      sentiment TEXT NOT NULL CHECK (sentiment IN ('positive','neutral','negative')),
      feature_requests TEXT NOT NULL,   -- JSON array of strings
      competitor_mentions TEXT NOT NULL, -- JSON array of strings
      urgency TEXT NOT NULL CHECK (urgency IN ('low','medium','high')),
      model TEXT NOT NULL,
      extracted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Second-pass aggregates. The dashboard reads ONLY from these tables, never
    -- from raw extractions. Rebuilt in full on every aggregation run.
    CREATE TABLE IF NOT EXISTS agg_themes (
      theme TEXT PRIMARY KEY,
      mentions INTEGER NOT NULL,
      last_aggregated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agg_feature_requests (
      feature TEXT PRIMARY KEY,
      requests INTEGER NOT NULL,
      segments TEXT NOT NULL, -- JSON array
      last_aggregated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agg_sentiment_weekly (
      week TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (week, sentiment)
    );
    CREATE TABLE IF NOT EXISTS agg_at_risk (
      customer_id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      segment TEXT NOT NULL,
      negative_count INTEGER NOT NULL,
      high_urgency_count INTEGER NOT NULL,
      competitor_mentioned INTEGER NOT NULL, -- 0/1
      risk_score REAL NOT NULL,
      last_aggregated TEXT NOT NULL
    );
  `);
}
