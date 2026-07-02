# Multi-Model Audit Consensus — 2026-07-02

Two independent auditors reviewed the codebase cold, neither seeing the other's
findings. Synthesis performed by Claude Fable 5, which cross-referenced both
reports, validated findings against the code, rejected non-applicable items,
and executed the accepted fixes.

- **Auditor A (adversarial/security lens):** GPT via Codex CLI 0.142.0, headless. Report: `FORGE_AUDIT_GPT.md` (13 findings, 2 critical).
- **Auditor B (structural/algorithmic lens):** Claude Fable 5 cold-context agent. Fallback: the planned GLM-5.2 auditor via OpenCode could not run — Z.AI API returned error 1113 (insufficient balance) on every call; opencode retried indefinitely. Logged per FORGE fallback rules; model diversity reduced for this pass. Report: 16 findings, 4 confirmed by executing the project's own modules.

## Consensus: accepted and fixed

| Fix | Found by | Evidence |
|---|---|---|
| HMAC-signed tokens; API accepts only {token, topic, body}; identity derived from verified signature | GPT #1 (Critical) + Fable #9 (root cause: token stored, never read) | New `src/token.ts`, server rewrite, tampered-token 401 verified live |
| Startup recovery of jobs stranded in `processing` | GPT #4 + Fable #2 | `recoverStaleJobs()`, called at boot, regression test |
| Exponential retry backoff (`next_attempt_at`) | GPT #7 + Fable #3 (confirmed: all 3 attempts burned in 2 ms) | Schema + `failJob`/`claimNextJob`, backoff test |
| Guarded atomic claim + status-guarded complete/fail | GPT #5 + Fable #7 | `UPDATE ... WHERE status='queued'`, changes check |
| ISO week parsing (SQLite space-datetime → Invalid Date → all weeks `NaN-WNaN`) | Fable #1 (confirmed in shipped feedback.db; dashboard trend panel nonfunctional) | Parse normalization + format regression test; live keys now `2026-W17`… |
| Word-boundary anchors in feature normalization ("payment processor" misfiled as "sso", confirmed) | Fable #4 | `\b` anchors, required groups, negative test |
| Validator coercion hole (`String(["negative"])` passes enum check, confirmed) | Fable #5 | typeof-before-membership, regression test |
| LLM call timeout (30s default, client retries disabled — retries belong to the queue) | GPT #6 | Anthropic client `timeout` + `maxRetries: 0` |
| Timer callbacks wrapped (daily aggregation tick can no longer kill the process) | GPT #11 + Fable #6 | try/catch in both loops |
| Topic allowlist (brief specifies a dropdown) | GPT #9 + Fable #8 | Server-side validation, 400 verified live |
| Customer feedback form route (`GET /form?token=...`) | GPT #10 | `public/form.html`, seed prints a sample tokenized link |
| Ingestion limits (32KB bodyLimit, 5000-char body cap) | GPT #3 (partial) | Fastify config + field check |
| Bind 127.0.0.1 by default; optional `ADMIN_TOKEN` bearer on admin POSTs | GPT #2 (partial) | Server config |
| DB path anchored to project dir, not cwd | Fable #11 | `db.ts` |
| Seed idempotency (refuses non-empty DB; re-dates only its own rows) | Fable #12 | `seed.ts` |
| Latest-seen customer metadata in at-risk aggregate | Fable #9 (partial) | Ordered join + overwrite |
| Direct-parse-first JSON extraction from LLM responses | Fable #13 | `extractor.ts` |
| `drainQueue` counts completed jobs, not claim cycles | Fable #16 | `worker.ts` |

## Rejected, with reasons

| Finding | Found by | Reason |
|---|---|---|
| Full authentication on dashboard/read APIs | GPT #2 | Demo runs locally in two minutes; the boundary is documented, bind is localhost, admin mutations gated by optional token. Production would sit behind SSO. |
| Async/202 aggregation instead of inline drain | GPT #8 + Fable #10 | Synchronous "aggregate now" is deliberate demo UX; backoff + LLM timeout bound the worst case (jobs in backoff are not claimable, so the drain exits immediately during provider outages). |
| Fail startup when no ANTHROPIC_API_KEY | GPT #12 | Zero-key runnability is the point of the demo. Mode is surfaced in startup log, `/api/health`, and README. |
| Exact dependency pins / CI audit | GPT #13 | `package-lock.json` is committed; `npm ci` reproduces. CI is out of scope for a same-day demo. |
| Zod (or equivalent) at every DB-read boundary | Fable #14 (partial) | HTTP boundary now validated; internal DB reads against our own schema stay as casts for demo scope. README names Zod as the production stance. |
| Full drain-await on shutdown | Fable #15 (partial) | Double-signal guard + try/catch shipped; graceful drain-await is production polish. |

## Post-fix verification

- `tsc --noEmit` clean, 20/20 tests green (7 new regression tests from audit findings)
- Live checks: valid signed token → 202; tampered token → 401; spoofed identity fields ignored; invalid topic → 400; `/form` serves; weekly sentiment keys real ISO weeks
