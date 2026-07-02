// Extraction layer. Two implementations behind one interface:
//   - AnthropicExtractor: real LLM structured extraction (needs ANTHROPIC_API_KEY)
//   - MockExtractor: deterministic keyword heuristics so the whole system runs
//     and demos with zero credentials.
// The worker doesn't know or care which one it has. Swapping providers is a
// one-line change, which is the point of the interface.

export interface Extraction {
  sentiment: "positive" | "neutral" | "negative";
  feature_requests: string[];
  competitor_mentions: string[];
  urgency: "low" | "medium" | "high";
  model: string;
}

export interface Extractor {
  extract(topic: string, body: string): Promise<Extraction>;
}

const SENTIMENTS = new Set(["positive", "neutral", "negative"]);
const URGENCIES = new Set(["low", "medium", "high"]);

export function validateExtraction(raw: unknown): Extraction {
  // LLM output is untrusted input. Validate the shape before it touches the
  // database; a validation failure is a job failure, which retries and can
  // dead-letter. Never store garbage. Type checks come before membership
  // checks: String(["negative"]) === "negative", so coercion would let an
  // array masquerade as a valid enum value.
  const obj = raw as Record<string, unknown>;
  if (typeof obj !== "object" || obj === null) throw new Error("extraction: not an object");
  if (typeof obj.sentiment !== "string" || !SENTIMENTS.has(obj.sentiment))
    throw new Error(`extraction: bad sentiment '${obj.sentiment}'`);
  if (typeof obj.urgency !== "string" || !URGENCIES.has(obj.urgency))
    throw new Error(`extraction: bad urgency '${obj.urgency}'`);
  if (!Array.isArray(obj.feature_requests) || !obj.feature_requests.every((f) => typeof f === "string"))
    throw new Error("extraction: feature_requests must be string[]");
  if (!Array.isArray(obj.competitor_mentions) || !obj.competitor_mentions.every((c) => typeof c === "string"))
    throw new Error("extraction: competitor_mentions must be string[]");
  return {
    sentiment: obj.sentiment as Extraction["sentiment"],
    urgency: obj.urgency as Extraction["urgency"],
    feature_requests: obj.feature_requests as string[],
    competitor_mentions: obj.competitor_mentions as string[],
    model: String(obj.model ?? "unknown"),
  };
}

// ---------------------------------------------------------------------------
// Mock extractor: keyword heuristics. Deterministic, instant, key-free.

const NEGATIVE_WORDS = ["frustrat", "broken", "cancel", "terrible", "slow", "confus", "disappoint", "unusable", "bug"];
const POSITIVE_WORDS = ["love", "great", "excellent", "amazing", "fantastic", "smooth", "happy"];
const URGENT_WORDS = ["urgent", "immediately", "asap", "deadline", "churn", "cancel", "switching", "deal breaker"];
const KNOWN_COMPETITORS = ["parloa", "cognigy", "polyai", "sierra", "decagon", "kore.ai", "boost.ai"];
const FEATURE_VERBS = ["wish", "need", "want", "would be great", "please add", "missing", "request"];

export class MockExtractor implements Extractor {
  async extract(topic: string, body: string): Promise<Extraction> {
    const text = `${topic} ${body}`.toLowerCase();
    const negHits = NEGATIVE_WORDS.filter((w) => text.includes(w)).length;
    const posHits = POSITIVE_WORDS.filter((w) => text.includes(w)).length;
    const sentiment = negHits > posHits ? "negative" : posHits > negHits ? "positive" : "neutral";
    const urgency = URGENT_WORDS.some((w) => text.includes(w)) ? "high" : negHits > 0 ? "medium" : "low";
    const competitor_mentions = KNOWN_COMPETITORS.filter((c) => text.includes(c));
    const feature_requests: string[] = [];
    if (FEATURE_VERBS.some((v) => text.includes(v))) {
      // Take the sentence containing the request verb as the feature request text.
      const sentence = body
        .split(/[.!?]/)
        .find((s) => FEATURE_VERBS.some((v) => s.toLowerCase().includes(v)));
      if (sentence) feature_requests.push(sentence.trim().slice(0, 120));
    }
    return validateExtraction({
      sentiment,
      urgency,
      feature_requests,
      competitor_mentions,
      model: "mock-heuristic-v1",
    });
  }
}

// ---------------------------------------------------------------------------
// Anthropic extractor: structured output via a constrained prompt.

const EXTRACTION_PROMPT = `You extract structured insight from customer feedback for a contact-center AI company.
Respond with ONLY a JSON object, no prose, matching exactly:
{"sentiment":"positive|neutral|negative","feature_requests":["short phrase"...],"competitor_mentions":["name"...],"urgency":"low|medium|high"}

Rules: sentiment reflects the customer's overall tone. feature_requests are concrete asks only, normalized to short noun phrases. competitor_mentions are product/company names only. urgency is high only when there is churn risk, a deadline, or blocking breakage.`;

export class AnthropicExtractor implements Extractor {
  private client: import("@anthropic-ai/sdk").default | null = null;
  private modelId = process.env.EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001";

  private async getClient() {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      // Bounded provider calls: a hung request fails the job (which retries
      // with backoff) instead of stalling the worker loop indefinitely.
      this.client = new Anthropic({
        timeout: Number(process.env.EXTRACTION_TIMEOUT_MS ?? 30_000),
        maxRetries: 0, // retries belong to the queue, not the HTTP client
      });
    }
    return this.client;
  }

  async extract(topic: string, body: string): Promise<Extraction> {
    const client = await this.getClient();
    const msg = await client.messages.create({
      model: this.modelId,
      max_tokens: 500,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: `Topic: ${topic}\n\nFeedback:\n${body}` }],
    });
    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    // Prefer parsing the whole response; fall back to brace extraction for
    // models that wrap JSON in prose.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("extraction: no JSON in model response");
      parsed = JSON.parse(jsonMatch[0]);
    }
    return validateExtraction({ ...(parsed as object), model: this.modelId });
  }
}

export function buildExtractor(): Extractor {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicExtractor() : new MockExtractor();
}
