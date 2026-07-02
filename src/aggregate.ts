import type Database from "better-sqlite3";

// Second pass. Individual extractions are noisy: "dark mode", "dark theme",
// "night mode" are one theme, not three. This pass normalizes and aggregates
// per-submission extractions into the tables the dashboard actually reads.
// Runs daily on a timer and on-demand via POST /api/aggregate. Full rebuild
// each run: idempotent, no drift.

function normalizeFeature(raw: string): string {
  // Cheap normalization: lowercase, strip filler, collapse known synonyms.
  // In production this step is itself an LLM call that clusters phrases;
  // the interface stays identical.
  let f = raw.toLowerCase().trim();
  const synonyms: [RegExp, string][] = [
    [/dark (mode|theme)|night mode/, "dark mode"],
    [/(salesforce|sfdc|crm) (integration|sync|connector)/, "crm integration"],
    [/(api|webhook)s? (access|support|integration)?/, "public api"],
    [/(export|download) (to )?(csv|excel|report)s?/, "data export"],
    [/sso|single sign.?on|saml|okta/, "sso"],
    [/(voice|call) (analytics|insights|transcri\w+)/, "voice analytics"],
    [/dashboard|reporting|analytics page/, "better reporting"],
    [/multi.?language|localization|german|spanish/, "multi-language support"],
  ];
  for (const [pattern, canonical] of synonyms) {
    if (pattern.test(f)) return canonical;
  }
  // Fall back to the first few words as the theme key.
  return f.replace(/^(i |we |please |would |wish |need |want |add )+/g, "").split(/\s+/).slice(0, 4).join(" ");
}

export function runAggregation(db: Database.Database): {
  themes: number;
  features: number;
  atRisk: number;
} {
  const now = new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT e.sentiment, e.feature_requests, e.competitor_mentions, e.urgency,
              s.customer_id, s.account_name, s.segment, s.topic, s.received_at
       FROM extractions e JOIN submissions s ON s.id = e.submission_id`
    )
    .all() as {
    sentiment: string;
    feature_requests: string;
    competitor_mentions: string;
    urgency: string;
    customer_id: string;
    account_name: string;
    segment: string;
    topic: string;
    received_at: string;
  }[];

  // Themes: topic dropdown counts (the structured signal we get for free).
  const themeCounts = new Map<string, number>();
  // Features: normalized free-text asks.
  const featureCounts = new Map<string, { n: number; segments: Set<string> }>();
  // Sentiment by ISO week.
  const weekly = new Map<string, Map<string, number>>();
  // At-risk per customer.
  const risk = new Map<
    string,
    { account_name: string; segment: string; neg: number; urgent: number; competitor: boolean }
  >();

  for (const r of rows) {
    themeCounts.set(r.topic, (themeCounts.get(r.topic) ?? 0) + 1);

    for (const raw of JSON.parse(r.feature_requests) as string[]) {
      const f = normalizeFeature(raw);
      if (!f) continue;
      const entry = featureCounts.get(f) ?? { n: 0, segments: new Set<string>() };
      entry.n++;
      entry.segments.add(r.segment);
      featureCounts.set(f, entry);
    }

    const week = isoWeek(r.received_at);
    const w = weekly.get(week) ?? new Map<string, number>();
    w.set(r.sentiment, (w.get(r.sentiment) ?? 0) + 1);
    weekly.set(week, w);

    const cust = risk.get(r.customer_id) ?? {
      account_name: r.account_name,
      segment: r.segment,
      neg: 0,
      urgent: 0,
      competitor: false,
    };
    if (r.sentiment === "negative") cust.neg++;
    if (r.urgency === "high") cust.urgent++;
    if ((JSON.parse(r.competitor_mentions) as string[]).length > 0) cust.competitor = true;
    risk.set(r.customer_id, cust);
  }

  const tx = db.transaction(() => {
    db.exec(
      `DELETE FROM agg_themes; DELETE FROM agg_feature_requests;
       DELETE FROM agg_sentiment_weekly; DELETE FROM agg_at_risk;`
    );
    const insTheme = db.prepare(`INSERT INTO agg_themes VALUES (?, ?, ?)`);
    for (const [theme, n] of themeCounts) insTheme.run(theme, n, now);

    const insFeat = db.prepare(`INSERT INTO agg_feature_requests VALUES (?, ?, ?, ?)`);
    for (const [feature, { n, segments }] of featureCounts)
      insFeat.run(feature, n, JSON.stringify([...segments]), now);

    const insWeek = db.prepare(`INSERT INTO agg_sentiment_weekly VALUES (?, ?, ?)`);
    for (const [week, counts] of weekly)
      for (const [sentiment, n] of counts) insWeek.run(week, sentiment, n);

    const insRisk = db.prepare(`INSERT INTO agg_at_risk VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [customerId, c] of risk) {
      // Risk score: negatives weigh 1, high-urgency 2, competitor mention 3.
      // Simple, explainable, tunable. Only customers with any signal get a row.
      const score = c.neg + c.urgent * 2 + (c.competitor ? 3 : 0);
      if (score > 0)
        insRisk.run(customerId, c.account_name, c.segment, c.neg, c.urgent, c.competitor ? 1 : 0, score, now);
    }
  });
  tx();

  return { themes: themeCounts.size, features: featureCounts.size, atRisk: [...risk.values()].filter((c) => c.neg + c.urgent > 0 || c.competitor).length };
}

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + (dateStr.includes("T") ? "" : "T00:00:00Z"));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function startAggregationLoop(db: Database.Database, intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => runAggregation(db), intervalMs);
}
