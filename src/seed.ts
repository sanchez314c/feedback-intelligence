import { createDb } from "./db.js";
import { enqueueSubmission } from "./queue.js";
import { buildExtractor } from "./extractor.js";
import { drainQueue } from "./worker.js";
import { runAggregation } from "./aggregate.js";

// Seeds ~40 realistic submissions across segments, runs the full pipeline
// (ingest → extract → aggregate) so the dashboard is populated on first run.

const db = createDb();
const extractor = buildExtractor();

const ACCOUNTS = [
  { customer_id: "cust-001", account_name: "Nordwind Insurance", segment: "enterprise" },
  { customer_id: "cust-002", account_name: "Helvetia Retail Group", segment: "enterprise" },
  { customer_id: "cust-003", account_name: "BlueRiver Airlines", segment: "enterprise" },
  { customer_id: "cust-004", account_name: "Cascade Telecom", segment: "mid-market" },
  { customer_id: "cust-005", account_name: "Meridian Health", segment: "mid-market" },
  { customer_id: "cust-006", account_name: "Solstice Energy", segment: "mid-market" },
  { customer_id: "cust-007", account_name: "Pine & Post Logistics", segment: "smb" },
  { customer_id: "cust-008", account_name: "Harbor Lane Hotels", segment: "smb" },
  { customer_id: "cust-009", account_name: "Copperfield Finance", segment: "smb" },
  { customer_id: "cust-010", account_name: "Atlas Mobility", segment: "enterprise" },
] as const;

const FEEDBACK: { topic: string; body: string }[] = [
  { topic: "Product Experience", body: "The agent builder is great overall. We would love a dark mode option for the console, our team works late shifts." },
  { topic: "Product Experience", body: "Really happy with the voice quality. Please add data export to CSV for the conversation logs, we need it for compliance." },
  { topic: "Integrations", body: "We need a Salesforce integration that syncs call outcomes automatically. Right now it is manual and slow." },
  { topic: "Integrations", body: "Missing webhook support for handoff events. Our engineers want API access to build internal tooling." },
  { topic: "Pricing & Billing", body: "Pricing is fine but invoicing is confusing. Neutral on value overall." },
  { topic: "Support", body: "Support was excellent this quarter, very fast response times. Love the new onboarding flow." },
  { topic: "Product Experience", body: "The dashboard is slow and honestly confusing. We are frustrated because reporting takes forever to load." },
  { topic: "Product Experience", body: "This is urgent: the German language model keeps failing mid-call. If this is not fixed before our Q3 launch deadline we have a serious problem." },
  { topic: "Competitive", body: "We are currently evaluating Cognigy alongside your product. Their analytics feel more mature. Would be great to see better reporting from you." },
  { topic: "Competitive", body: "Sierra pitched us last week and their pricing undercuts yours. We love your product but finance is pushing us to consider switching." },
  { topic: "Support", body: "Ticket resolution has been slow lately. A bit disappointed compared to last year." },
  { topic: "Product Experience", body: "We wish there was multi-language support for Spanish dialects. Our LATAM expansion depends on it." },
  { topic: "Integrations", body: "Please add SSO with Okta. Security team is blocking wider rollout until single sign-on lands." },
  { topic: "Product Experience", body: "Amazing improvements this quarter. The new voice analytics are fantastic and the team is happy." },
  { topic: "Pricing & Billing", body: "We need usage-based pricing tiers. Current model does not fit our seasonal call volume." },
  { topic: "Support", body: "Honestly terrible experience with the last escalation. Broken promises on timelines. We are frustrated and evaluating PolyAI as a backup." },
  { topic: "Product Experience", body: "The agent handoff feature works smoothly now. Great job on the last release." },
  { topic: "Integrations", body: "Would be great to have a native Zendesk connector. We want ticket context inside the agent view." },
  { topic: "Product Experience", body: "Voice latency has been noticeably worse this month. Customers notice the pauses. This needs attention asap." },
  { topic: "Competitive", body: "Decagon demoed for our support org. We are staying with you for now but their summarization feature is something we wish you had." },
];

let seeded = 0;
for (let i = 0; i < 40; i++) {
  const account = ACCOUNTS[i % ACCOUNTS.length];
  const fb = FEEDBACK[i % FEEDBACK.length];
  enqueueSubmission(db, {
    token: `tok-${account.customer_id}-${i}`,
    ...account,
    ...fb,
  });
  seeded++;
}

// Spread received_at over the past 10 weeks so the sentiment trend has shape.
const subs = db.prepare(`SELECT id FROM submissions ORDER BY id`).all() as { id: number }[];
const update = db.prepare(`UPDATE submissions SET received_at = datetime('now', ?) WHERE id = ?`);
subs.forEach((s, idx) => {
  const daysAgo = Math.floor((idx / subs.length) * 70);
  update.run(`-${daysAgo} days`, s.id);
});

console.log(`seeded ${seeded} submissions, processing...`);
const processed = await drainQueue(db, extractor);
console.log(`processed ${processed} jobs`);
const agg = runAggregation(db);
console.log(`aggregated: ${agg.themes} themes, ${agg.features} normalized feature requests, ${agg.atRisk} at-risk accounts`);
db.close();
console.log(`done. run: npm start  →  http://localhost:4400`);
