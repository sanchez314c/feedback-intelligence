import type Database from "better-sqlite3";
import { claimNextJob, completeJob, failJob } from "./queue.js";
import type { Extractor } from "./extractor.js";

// The worker drains the queue: claim → extract → store → complete.
// Any throw (LLM timeout, bad output shape, network) routes through failJob,
// which retries up to the cap and then dead-letters. The worker never crashes
// the process over one bad submission.

export async function processOne(
  db: Database.Database,
  extractor: Extractor
): Promise<"done" | "failed" | false> {
  const job = claimNextJob(db);
  if (!job) return false;

  const sub = db
    .prepare(`SELECT topic, body FROM submissions WHERE id = ?`)
    .get(job.submission_id) as { topic: string; body: string } | undefined;

  if (!sub) {
    failJob(db, job, "submission row missing");
    return "failed";
  }

  try {
    const ex = await extractor.extract(sub.topic, sub.body);
    db.prepare(
      `INSERT OR REPLACE INTO extractions
       (submission_id, sentiment, feature_requests, competitor_mentions, urgency, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      job.submission_id,
      ex.sentiment,
      JSON.stringify(ex.feature_requests),
      JSON.stringify(ex.competitor_mentions),
      ex.urgency,
      ex.model
    );
    completeJob(db, job.id);
    return "done";
  } catch (err) {
    const state = failJob(db, job, err instanceof Error ? err.message : String(err));
    console.error(`[worker] job ${job.id} attempt ${job.attempts} failed → ${state}:`, err);
    return "failed";
  }
}

// Returns the number of jobs COMPLETED (a job retried twice then done counts
// once; a dead-lettered job counts zero).
export async function drainQueue(db: Database.Database, extractor: Extractor): Promise<number> {
  let completed = 0;
  for (;;) {
    const result = await processOne(db, extractor);
    if (result === false) break;
    if (result === "done") completed++;
  }
  return completed;
}

export function startWorkerLoop(db: Database.Database, extractor: Extractor, intervalMs = 3000): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return; // no overlapping drains
    running = true;
    try {
      await drainQueue(db, extractor);
    } catch (err) {
      // A throw outside processOne's try (e.g. SQLITE_BUSY on claim) must not
      // become an unhandled rejection that kills the server.
      console.error("[worker] drain error:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
}
