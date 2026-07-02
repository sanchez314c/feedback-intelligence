# Feedback Intelligence

A working implementation of the Customer Feedback Intelligence System from my Parloa technical interview (July 2, 2026). The Miro sketch was the exercise. This is how I actually answer: I built it the same afternoon.

Runs with zero infrastructure and zero API keys. Clone it, seed it, open the dashboard.

```bash
npm install
npm run seed     # 40 realistic submissions through the full pipeline
npm start        # http://localhost:4400
npm test         # 13 tests: queue lifecycle, DLQ, extraction validation, aggregation
```

## The architecture

```
form submission
      |
      v
POST /api/feedback ──> submissions table   (durable write FIRST, 202 returned)
      |                     |
      +──> jobs table ──────+   (same transaction: store + promise-to-process are atomic)
      |
      v
worker loop: claim -> LLM extraction -> extractions table
      |                    |
      |              fail: retry up to 3x
      |                    |
      |              still failing -> dead-letter (status='dead')
      |                                  |
      |                    POST /api/dlq/reprocess requeues them
      v
aggregation pass (daily timer + POST /api/aggregate on demand)
      |    normalizes noisy per-submission extractions:
      |    "dark mode" + "night mode" -> one feature request
      v
agg_* tables ──> GET /api/trends, /api/at-risk ──> dashboard
```

## The three requirements, mapped to code

**1. Collect & store, never lose feedback, failed processing is reprocessable.**
`POST /api/feedback` writes the raw submission and its processing job in one transaction (`src/queue.ts`, `enqueueSubmission`). Storage happens before any LLM is involved, so a dead LLM provider can never lose feedback. Failed jobs retry up to 3 attempts, then land in a dead-letter state instead of vanishing. `POST /api/dlq/reprocess` puts them back in the queue. The tests prove the whole lifecycle (`tests/queue.test.ts`).

**2. Analyze each submission automatically, not instantly.**
A worker loop (`src/worker.ts`) drains the queue every few seconds and calls the extractor: sentiment, feature requests, competitor mentions, urgency. LLM output is validated before it touches the database (`validateExtraction`); malformed output is a job failure, which retries. The client never waits on an LLM: submission returns `202` immediately.

**3. Surface trends: second pass over noisy extractions.**
`src/aggregate.ts` rebuilds the aggregate tables from scratch on every run (idempotent): topic themes, normalized top feature requests, weekly sentiment trend, and at-risk accounts scored from negative sentiment, high urgency, and competitor mentions. Runs daily on a timer and on demand via `POST /api/aggregate`. The dashboard reads only aggregates, never raw extractions.

## Decisions and their production mapping

| This demo | Production | Why the demo choice |
|---|---|---|
| SQLite (WAL mode) | Postgres | Zero setup, same write-first durability semantics |
| `jobs` table as queue | Kafka / Redis queue + DLQ | Makes retry/dead-letter mechanics visible in ~60 lines instead of hiding them behind infra |
| Mock extractor fallback | Always real LLM | System runs and demos with no credentials; set `ANTHROPIC_API_KEY` and it uses Claude with the same interface |
| Regex synonym normalization | LLM clustering pass | Same interface, cheaper demo; swap `normalizeFeature` for a model call |
| Static HTML dashboard | React app | `npm start` and it works, no build step between you and the demo |

At 5,000 submissions a year (about 14 a day), nothing here is a scale problem. The design weight goes where the brief put it: durability, reprocessability, and turning noisy extractions into signal.

## Real LLM extraction

```bash
ANTHROPIC_API_KEY=sk-... npm run seed
```

Same pipeline, real structured extraction through Claude (`src/extractor.ts`, `AnthropicExtractor`). The prompt constrains output to a strict JSON schema and `validateExtraction` rejects anything that drifts.

## Layout

```
src/db.ts         schema + migrations (submissions, jobs, extractions, agg_*)
src/queue.ts      enqueue, claim, complete, fail/retry, dead-letter, reprocess
src/extractor.ts  Extractor interface, Anthropic + mock implementations, validation
src/worker.ts     queue drain loop, per-job error isolation
src/aggregate.ts  second-pass normalization + at-risk scoring
src/server.ts     Fastify API + dashboard hosting
src/seed.ts       40 submissions across 10 accounts, full pipeline run
public/index.html dashboard (themes, features, sentiment trend, at-risk)
tests/            queue lifecycle, DLQ, validation, aggregation idempotency
```

Built by Jason Paul Michaels, the afternoon after the interview.
