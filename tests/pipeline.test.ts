import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db.js";
import { enqueueSubmission, queueStats } from "../src/queue.js";
import { MockExtractor, validateExtraction, type Extractor } from "../src/extractor.js";
import { drainQueue } from "../src/worker.js";
import { runAggregation } from "../src/aggregate.js";

let db: Database.Database;
beforeEach(() => {
  db = createDb(":memory:");
});

function seed(customer_id: string, account_name: string, segment: string, topic: string, body: string) {
  enqueueSubmission(db, { token: `tok-${customer_id}`, customer_id, account_name, segment, topic, body });
}

describe("extraction validation", () => {
  it("accepts a well-formed extraction", () => {
    const ex = validateExtraction({
      sentiment: "negative",
      urgency: "high",
      feature_requests: ["dark mode"],
      competitor_mentions: ["cognigy"],
      model: "test",
    });
    expect(ex.sentiment).toBe("negative");
  });

  it("rejects malformed LLM output so garbage never reaches the database", () => {
    expect(() => validateExtraction({ sentiment: "angry", urgency: "high", feature_requests: [], competitor_mentions: [] })).toThrow();
    expect(() => validateExtraction({ sentiment: "negative", urgency: "high", feature_requests: "dark mode", competitor_mentions: [] })).toThrow();
    expect(() => validateExtraction(null)).toThrow();
  });
});

describe("worker", () => {
  it("drains the queue and stores extractions", async () => {
    seed("c1", "Acme", "smb", "Support", "Support was excellent, we love it.");
    seed("c2", "Beta Inc", "enterprise", "Product Experience", "This is urgent, the dashboard is broken and we are frustrated.");
    const processed = await drainQueue(db, new MockExtractor());
    expect(processed).toBe(2);
    expect(queueStats(db)).toEqual({ done: 2 });
    const rows = db.prepare("SELECT sentiment, urgency FROM extractions ORDER BY submission_id").all() as any[];
    expect(rows[0].sentiment).toBe("positive");
    expect(rows[1].sentiment).toBe("negative");
    expect(rows[1].urgency).toBe("high");
  });

  it("a failing extractor retries then dead-letters without crashing", async () => {
    seed("c1", "Acme", "smb", "Support", "anything");
    const alwaysFails: Extractor = {
      extract: async () => {
        throw new Error("provider down");
      },
    };
    await drainQueue(db, alwaysFails);
    // drainQueue keeps claiming until the job dead-letters; queue must end drained.
    expect(queueStats(db)).toEqual({ dead: 1 });
  });
});

describe("aggregation second pass", () => {
  it("normalizes synonym feature requests into one theme", async () => {
    seed("c1", "Acme", "smb", "Product Experience", "We wish there was a dark mode option.");
    seed("c2", "Beta", "enterprise", "Product Experience", "Please add a night mode, would be great.");
    await drainQueue(db, new MockExtractor());
    runAggregation(db);
    const features = db.prepare("SELECT feature, requests FROM agg_feature_requests").all() as any[];
    const darkMode = features.find((f) => f.feature === "dark mode");
    expect(darkMode).toBeDefined();
    expect(darkMode.requests).toBe(2);
  });

  it("flags at-risk accounts from negative + urgent + competitor signals", async () => {
    seed("c9", "ChurnCo", "enterprise", "Competitive", "We are frustrated and evaluating Cognigy. This is urgent, we may cancel.");
    seed("c8", "HappyCo", "smb", "Support", "We love everything, great work.");
    await drainQueue(db, new MockExtractor());
    runAggregation(db);
    const risk = db.prepare("SELECT customer_id, risk_score FROM agg_at_risk ORDER BY risk_score DESC").all() as any[];
    expect(risk.length).toBe(1);
    expect(risk[0].customer_id).toBe("c9");
    expect(risk[0].risk_score).toBeGreaterThanOrEqual(5);
  });

  it("is idempotent: rerunning produces identical aggregates", async () => {
    seed("c1", "Acme", "smb", "Support", "Support was excellent.");
    await drainQueue(db, new MockExtractor());
    runAggregation(db);
    const first = db.prepare("SELECT * FROM agg_themes").all();
    runAggregation(db);
    const second = db.prepare("SELECT * FROM agg_themes").all();
    expect(second.map((r: any) => [r.theme, r.mentions])).toEqual(first.map((r: any) => [r.theme, r.mentions]));
  });
});
