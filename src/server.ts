import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "./db.js";
import { enqueueSubmission, reprocessDeadJobs, recoverStaleJobs, queueStats } from "./queue.js";
import { verifyToken } from "./token.js";
import { buildExtractor } from "./extractor.js";
import { startWorkerLoop, drainQueue } from "./worker.js";
import { runAggregation, startAggregationLoop } from "./aggregate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = createDb();
const extractor = buildExtractor();

// Crash recovery: jobs stranded in 'processing' by a previous run requeue on boot.
const recovered = recoverStaleJobs(db);
if (recovered > 0) console.log(`[startup] recovered ${recovered} stale processing job(s)`);

// 32KB is generous for a feedback form and starves payload abuse.
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
await app.register(fastifyStatic, { root: join(__dirname, "..", "public") });

// The brief's topic dropdown, enforced server-side so arbitrary strings can't
// pollute the themes aggregate.
export const VALID_TOPICS = [
  "Product Experience",
  "Integrations",
  "Pricing & Billing",
  "Support",
  "Competitive",
] as const;
const TOPIC_SET = new Set<string>(VALID_TOPICS);
const MAX_BODY_CHARS = 5000;

// Optional bearer guard for admin actions. Unset = open (local demo);
// set ADMIN_TOKEN and the mutating admin endpoints require it.
function adminGuard(req: { headers: Record<string, unknown> }): boolean {
  const required = process.env.ADMIN_TOKEN;
  if (!required) return true;
  return req.headers["authorization"] === `Bearer ${required}`;
}

// Requirement 1: collect & store. The token IS the identity: HMAC-verified,
// minted when the outbound link was generated. The API never trusts
// client-supplied identity fields — it accepts only token, topic, body.
app.post("/api/feedback", async (req, reply) => {
  const b = req.body as Record<string, unknown>;
  for (const field of ["token", "topic", "body"]) {
    if (!b?.[field] || typeof b[field] !== "string")
      return reply.code(400).send({ error: `missing or invalid field: ${field}` });
  }
  const { token, topic, body } = b as { token: string; topic: string; body: string };
  if (!TOPIC_SET.has(topic))
    return reply.code(400).send({ error: `topic must be one of: ${VALID_TOPICS.join(", ")}` });
  if (body.length > MAX_BODY_CHARS)
    return reply.code(400).send({ error: `body exceeds ${MAX_BODY_CHARS} characters` });

  let identity;
  try {
    identity = verifyToken(token);
  } catch {
    return reply.code(401).send({ error: "invalid or tampered token" });
  }

  const { submissionId, jobId } = enqueueSubmission(db, {
    token,
    customer_id: identity.customer_id,
    account_name: identity.account_name,
    segment: identity.segment,
    topic,
    body,
  });
  // 202: stored durably, analysis happens async. The client never waits on an LLM.
  return reply.code(202).send({ submission_id: submissionId, job_id: jobId, status: "queued" });
});

// The customer-facing form from the brief: tokenized link → topic dropdown +
// free text. The token rides the query string into the static form page.
app.get("/form", async (_req, reply) => {
  return reply.sendFile("form.html");
});

// Requirement 1 recovery path: reprocess dead-lettered jobs.
app.post("/api/dlq/reprocess", async (req, reply) => {
  if (!adminGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  const requeued = reprocessDeadJobs(db);
  return { requeued };
});

// Requirement 3: on-demand aggregation (also runs daily on a timer).
// Flushes claimable pending work first so "aggregate now" reflects everything
// extractable; backoff keeps this bounded when the provider is failing.
app.post("/api/aggregate", async (req, reply) => {
  if (!adminGuard(req)) return reply.code(401).send({ error: "unauthorized" });
  await drainQueue(db, extractor);
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
// Localhost by default; set HOST=0.0.0.0 to expose deliberately.
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`feedback-intelligence listening on http://localhost:${port}`);
console.log(`extractor: ${process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock (set ANTHROPIC_API_KEY for real LLM extraction)"}`);

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(workerTimer);
    clearInterval(aggTimer);
    try {
      await app.close();
      db.close();
    } catch (err) {
      console.error("[shutdown]", err);
    }
    process.exit(0);
  });
}
