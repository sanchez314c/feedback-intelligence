import type Database from "better-sqlite3";

// Queue mechanics: claim → process → complete | fail(retry w/ backoff) → dead-letter.
// MAX_ATTEMPTS exhausted moves the job to 'dead' instead of deleting it, so a
// human (or an endpoint) can inspect and reprocess. Nothing is ever lost.

export const MAX_ATTEMPTS = 3;

// Exponential backoff base. Tests set RETRY_BACKOFF_SECONDS=0 to keep retries
// immediate; production default spaces attempts 30s / 120s apart so a transient
// provider blip doesn't burn every attempt in milliseconds.
const backoffSeconds = (attempts: number): number => {
  const base = Number(process.env.RETRY_BACKOFF_SECONDS ?? 30);
  return attempts * attempts * base;
};

export interface Job {
  id: number;
  submission_id: number;
  status: "queued" | "processing" | "done" | "dead";
  attempts: number;
  last_error: string | null;
}

export function enqueueSubmission(
  db: Database.Database,
  sub: {
    token: string;
    customer_id: string;
    account_name: string;
    segment: string;
    topic: string;
    body: string;
  }
): { submissionId: number; jobId: number } {
  // Submission row and job row are written in ONE transaction: the durability
  // guarantee and the promise-to-process are atomic. If this commits, the
  // feedback exists and will eventually be analyzed.
  const tx = db.transaction(() => {
    const subResult = db
      .prepare(
        `INSERT INTO submissions (token, customer_id, account_name, segment, topic, body)
         VALUES (@token, @customer_id, @account_name, @segment, @topic, @body)`
      )
      .run(sub);
    const submissionId = Number(subResult.lastInsertRowid);
    const jobResult = db
      .prepare(`INSERT INTO jobs (submission_id) VALUES (?)`)
      .run(submissionId);
    return { submissionId, jobId: Number(jobResult.lastInsertRowid) };
  });
  return tx();
}

export function claimNextJob(db: Database.Database): Job | undefined {
  // Guarded claim: the UPDATE only wins if the row is still 'queued', so two
  // processes sharing the DB can never claim the same job (last-write-wins
  // races are excluded at the SQL level, not by process architecture).
  // In Postgres this is SELECT ... FOR UPDATE SKIP LOCKED.
  for (;;) {
    const job = db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'queued' AND next_attempt_at <= datetime('now')
         ORDER BY id LIMIT 1`
      )
      .get() as Job | undefined;
    if (!job) return undefined;
    const claimed = db
      .prepare(
        `UPDATE jobs SET status = 'processing', attempts = attempts + 1,
         updated_at = datetime('now') WHERE id = ? AND status = 'queued'`
      )
      .run(job.id);
    if (claimed.changes === 1) return { ...job, status: "processing", attempts: job.attempts + 1 };
    // Someone else won the race for this row; try the next candidate.
  }
}

export function completeJob(db: Database.Database, jobId: number): void {
  // Guarded on status so a stale worker can't flip an already-recovered job.
  db.prepare(
    `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = 'processing'`
  ).run(jobId);
}

export function failJob(db: Database.Database, job: Job, error: string): "queued" | "dead" {
  // Under the attempt cap the job requeues with exponential backoff.
  // At the cap it dead-letters: visible, inspectable, reprocessable.
  const next = job.attempts >= MAX_ATTEMPTS ? "dead" : "queued";
  db.prepare(
    `UPDATE jobs SET status = ?, last_error = ?,
     next_attempt_at = datetime('now', '+' || ? || ' seconds'),
     updated_at = datetime('now')
     WHERE id = ? AND status = 'processing'`
  ).run(next, error, backoffSeconds(job.attempts), job.id);
  return next;
}

export function reprocessDeadJobs(db: Database.Database): number {
  // The recovery path for requirement 1: failed submissions can be reprocessed.
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL,
       next_attempt_at = datetime('now'), updated_at = datetime('now')
       WHERE status = 'dead'`
    )
    .run();
  return result.changes;
}

export function recoverStaleJobs(db: Database.Database): number {
  // Crash recovery: a process that died between claim and complete leaves jobs
  // stuck in 'processing' forever. Called at startup (single-instance
  // semantics; multi-instance deployments use a lease timestamp instead).
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'queued', next_attempt_at = datetime('now'),
       updated_at = datetime('now') WHERE status = 'processing'`
    )
    .run();
  return result.changes;
}

export function queueStats(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`)
    .all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
