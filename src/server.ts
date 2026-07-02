import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "./db.js";
import { enqueueSubmission, reprocessDeadJobs, queueStats } from "./queue.js";
import { buildExtractor } from "./extractor.js";
import { startWorkerLoop, drainQueue } from "./worker.js";
import { runAggregation, startAggregationLoop } from "./aggregate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = createDb();
const extractor = buildExtractor();

const app = Fastify({ logger: false });
await app.register(fastifyStatic, { root: join(__dirname, "..", "public") });

const VALID_SEGMENTS = new Set(["enterprise", "mid-market", "smb"]);

// Requirement 1: collect & store. Token resolves identity server-side (the
// brief says no lookup needed at submission time, so the demo trusts a signed
// token payload; production verifies an HMAC signature on it).
app.post("/api/feedback", async (req, reply) => {
  const b = req.body as Record<string, string>;
  for (const field of ["token", "customer_id", "account_name", "segment", "topic", "body"]) {
    if (!b?.[field] || typeof b[field] !== "string")
      return reply.code(400).send({ error: `missing or invalid field: ${field}` });
  }
  if (!VALID_SEGMENTS.has(b.segment))
    return reply.code(400).send({ error: "segment must be enterprise | mid-market | smb" });

  const { submissionId, jobId } = enqueueSubmission(db, {
    token: b.token,
    customer_id: b.customer_id,
    account_name: b.account_name,
    segment: b.segment,
    topic: b.topic,
    body: b.body,
  });
  // 202: stored durably, analysis happens async. The client never waits on an LLM.
  return reply.code(202).send({ submission_id: submissionId, job_id: jobId, status: "queued" });
});

// Requirement 1 recovery path: reprocess dead-lettered jobs.
app.post("/api/dlq/reprocess", async () => {
  const requeued = reprocessDeadJobs(db);
  return { requeued };
});

// Requirement 3: on-demand aggregation (also runs daily on a timer).
app.post("/api/aggregate", async () => {
  await drainQueue(db, extractor); // flush anything pending first
  return runAggregation(db);
});

app.get("/api/trends", async () => {
  return {
    themes: db.prepare(`SELECT theme, mentions FROM agg_themes ORDER BY mentions DESC`).all(),
    top_feature_requests: db
      .prepare(`SELECT feature, requests, segments FROM agg_feature_requests ORDER BY requests DESC LIMIT 10`)
      .all()
      .map((r: any) => ({ ...r, segments: JSON.parse(r.segments) })),
    sentiment_weekly: db
      .prepare(`SELECT week, sentiment, count FROM agg_sentiment_weekly ORDER BY week`)
      .all(),
  };
});

app.get("/api/at-risk", async () => {
  return db
    .prepare(
      `SELECT customer_id, account_name, segment, negative_count, high_urgency_count,
              competitor_mentioned, risk_score
       FROM agg_at_risk ORDER BY risk_score DESC LIMIT 20`
    )
    .all();
});

app.get("/api/health", async () => ({
  ok: true,
  queue: queueStats(db),
  extractor: process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock",
}));

const workerTimer = startWorkerLoop(db, extractor);
const aggTimer = startAggregationLoop(db);

const port = Number(process.env.PORT ?? 4400);
await app.listen({ port, host: "0.0.0.0" });
console.log(`feedback-intelligence listening on http://localhost:${port}`);
console.log(`extractor: ${process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock (set ANTHROPIC_API_KEY for real LLM extraction)"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    clearInterval(workerTimer);
    clearInterval(aggTimer);
    await app.close();
    db.close();
    process.exit(0);
  });
}
