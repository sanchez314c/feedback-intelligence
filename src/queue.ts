import type Database from "better-sqlite3";

// Queue mechanics: claim → process → complete | fail(retry) → dead-letter.
// MAX_ATTEMPTS exhausted moves the job to 'dead' instead of deleting it, so a
// human (or an endpoint) can inspect and reprocess. Nothing is ever lost.

export const MAX_ATTEMPTS = 3;

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
  // Atomic claim: flip queued → processing and return the row. Single-writer
  // SQLite makes this race-free; in Postgres this is SELECT ... FOR UPDATE SKIP LOCKED.
  const job = db
    .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`)
    .get() as Job | undefined;
  if (!job) return undefined;
  db.prepare(
    `UPDATE jobs SET status = 'processing', attempts = attempts + 1,
     updated_at = datetime('now') WHERE id = ?`
  ).run(job.id);
  return { ...job, status: "processing", attempts: job.attempts + 1 };
}

export function completeJob(db: Database.Database, jobId: number): void {
  db.prepare(
    `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(jobId);
}

export function failJob(db: Database.Database, job: Job, error: string): "queued" | "dead" {
  // Under the attempt cap the job goes back to queued for retry.
  // At the cap it dead-letters: visible, inspectable, reprocessable.
  const next = job.attempts >= MAX_ATTEMPTS ? "dead" : "queued";
  db.prepare(
    `UPDATE jobs SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(next, error, job.id);
  return next;
}

export function reprocessDeadJobs(db: Database.Database): number {
  // The recovery path for requirement 1: failed submissions can be reprocessed.
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL,
       updated_at = datetime('now') WHERE status = 'dead'`
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
