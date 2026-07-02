import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db.js";
import { enqueueSubmission, claimNextJob, failJob, recoverStaleJobs, queueStats } from "../src/queue.js";
import { makeToken, verifyToken } from "../src/token.js";
import { validateExtraction, MockExtractor } from "../src/extractor.js";
import { drainQueue } from "../src/worker.js";
import { runAggregation } from "../src/aggregate.js";

// Regression tests for findings from the multi-model audit (Codex adversarial
// pass + structural pass). Each block names the failure it pins down.

process.env.RETRY_BACKOFF_SECONDS = "0";

const SUB = {
  token: "tok",
  customer_id: "c1",
  account_name: "Acme",
  segment: "smb",
  topic: "Support",
  body: "text",
};

let db: Database.Database;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("signed tokens (identity cannot be spoofed)", () => {
  it("round-trips identity through sign and verify", () => {
    const id = { customer_id: "cust-42", account_name: "Nordwind Insurance", segment: "enterprise" };
    expect(verifyToken(makeToken(id))).toEqual(id);
  });

  it("rejects tampered payloads and signatures", () => {
    const token = makeToken({ customer_id: "c1", account_name: "A", segment: "smb" });
    const [payload, mac] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify(["c1", "A", "enterprise"])).toString("base64url");
    expect(() => verifyToken(`${forgedPayload}.${mac}`)).toThrow();
    expect(() => verifyToken(`${payload}.${"0".repeat(mac.length)}`)).toThrow();
    expect(() => verifyToken("garbage")).toThrow();
  });
});

describe("crash recovery (stale processing jobs)", () => {
  it("requeues jobs stranded in processing by a dead worker", () => {
    enqueueSubmission(db, SUB);
    claimNextJob(db); // simulate crash: claimed, never completed
    expect(queueStats(db)).toEqual({ processing: 1 });
    expect(recoverStaleJobs(db)).toBe(1);
    expect(queueStats(db)).toEqual({ queued: 1 });
    expect(claimNextJob(db)).toBeDefined(); // claimable again
  });
});

describe("retry backoff (transient failures must not insta-dead-letter)", () => {
  afterEach(() => {
    process.env.RETRY_BACKOFF_SECONDS = "0";
  });

  it("a failed job is not immediately reclaimable when backoff is set", () => {
    process.env.RETRY_BACKOFF_SECONDS = "60";
    enqueueSubmission(db, SUB);
    const job = claimNextJob(db)!;
    failJob(db, job, "transient provider blip");
    expect(queueStats(db)).toEqual({ queued: 1 }); // requeued, not dead
    expect(claimNextJob(db)).toBeUndefined(); // but held back by next_attempt_at
  });
});

describe("extraction validator (coercion holes)", () => {
  it("rejects arrays masquerading as enum strings", () => {
    expect(() =>
      validateExtraction({
        sentiment: ["negative"],
        urgency: "high",
        feature_requests: [],
        competitor_mentions: [],
      })
    ).toThrow(/bad sentiment/);
    expect(() =>
      validateExtraction({
        sentiment: "negative",
        urgency: ["high"],
        feature_requests: [],
        competitor_mentions: [],
      })
    ).toThrow(/bad urgency/);
  });
});

describe("aggregation correctness", () => {
  it("weekly sentiment buckets use real ISO week keys, not NaN", async () => {
    enqueueSubmission(db, { ...SUB, body: "Support was excellent, love it." });
    await drainQueue(db, new MockExtractor());
    runAggregation(db);
    const weeks = db.prepare(`SELECT week FROM agg_sentiment_weekly`).all() as { week: string }[];
    expect(weeks.length).toBeGreaterThan(0);
    for (const w of weeks) expect(w.week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("does not misfile substring matches: 'payment processor' is not 'sso'", async () => {
    enqueueSubmission(db, {
      ...SUB,
      customer_id: "c7",
      body: "We need a better payment processor integration for refunds.",
    });
    await drainQueue(db, new MockExtractor());
    runAggregation(db);
    const features = db.prepare(`SELECT feature FROM agg_feature_requests`).all() as { feature: string }[];
    expect(features.map((f) => f.feature)).not.toContain("sso");
  });
});
