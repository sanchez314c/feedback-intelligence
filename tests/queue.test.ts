import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db.js";
import {
  enqueueSubmission,
  claimNextJob,
  completeJob,
  failJob,
  reprocessDeadJobs,
  queueStats,
  MAX_ATTEMPTS,
} from "../src/queue.js";

const SUB = {
  token: "tok-test",
  customer_id: "cust-t1",
  account_name: "Test Corp",
  segment: "smb",
  topic: "Product Experience",
  body: "test feedback body",
};

let db: Database.Database;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("durable ingestion", () => {
  it("writes submission and job atomically", () => {
    const { submissionId, jobId } = enqueueSubmission(db, SUB);
    expect(submissionId).toBeGreaterThan(0);
    expect(jobId).toBeGreaterThan(0);
    const sub = db.prepare("SELECT * FROM submissions WHERE id = ?").get(submissionId);
    expect(sub).toBeDefined();
    expect(queueStats(db)).toEqual({ queued: 1 });
  });
});

describe("queue lifecycle", () => {
  it("claim moves queued to processing and increments attempts", () => {
    enqueueSubmission(db, SUB);
    const job = claimNextJob(db)!;
    expect(job.status).toBe("processing");
    expect(job.attempts).toBe(1);
    expect(claimNextJob(db)).toBeUndefined(); // nothing else queued
  });

  it("complete marks job done", () => {
    enqueueSubmission(db, SUB);
    const job = claimNextJob(db)!;
    completeJob(db, job.id);
    expect(queueStats(db)).toEqual({ done: 1 });
  });

  it("failure below the cap requeues for retry", () => {
    enqueueSubmission(db, SUB);
    const job = claimNextJob(db)!;
    const state = failJob(db, job, "llm timeout");
    expect(state).toBe("queued");
    expect(queueStats(db)).toEqual({ queued: 1 });
  });

  it("failure at the cap dead-letters instead of losing the job", () => {
    enqueueSubmission(db, SUB);
    let job = claimNextJob(db)!;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      failJob(db, job, `attempt ${i} failed`);
      job = claimNextJob(db)!;
    }
    expect(job.attempts).toBe(MAX_ATTEMPTS);
    const state = failJob(db, job, "final failure");
    expect(state).toBe("dead");
    expect(queueStats(db)).toEqual({ dead: 1 });
    // The submission itself is still intact — nothing was lost.
    expect(db.prepare("SELECT COUNT(*) as n FROM submissions").get()).toEqual({ n: 1 });
  });

  it("dead jobs can be reprocessed", () => {
    enqueueSubmission(db, SUB);
    let job = claimNextJob(db)!;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      failJob(db, job, "fail");
      const next = claimNextJob(db);
      if (!next) break;
      job = next;
    }
    expect(queueStats(db)).toEqual({ dead: 1 });
    const requeued = reprocessDeadJobs(db);
    expect(requeued).toBe(1);
    expect(queueStats(db)).toEqual({ queued: 1 });
    const fresh = claimNextJob(db)!;
    expect(fresh.attempts).toBe(1); // attempts reset on reprocess
  });
});
