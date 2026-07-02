import { createHmac, timingSafeEqual } from "node:crypto";

// The brief: "the token resolves to the customer's identity, account, and
// segment — no lookup needed at submission time." That means the token IS the
// identity, and it must be tamper-proof. HMAC-signed payload: the server mints
// tokens when generating outbound links and verifies the signature on every
// submission. The API never trusts client-supplied identity fields.
//
// Demo secret defaults so the repo runs out of the box; production injects
// TOKEN_SECRET from a secret manager.

const SECRET = () => process.env.TOKEN_SECRET ?? "demo-secret-change-me";

export interface TokenIdentity {
  customer_id: string;
  account_name: string;
  segment: string;
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET()).update(payload).digest("hex");
}

export function makeToken(id: TokenIdentity): string {
  const payload = Buffer.from(
    JSON.stringify([id.customer_id, id.account_name, id.segment])
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): TokenIdentity {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new Error("token: malformed");
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  const macBuf = Buffer.from(mac, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf))
    throw new Error("token: bad signature");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    throw new Error("token: bad payload");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((p) => typeof p === "string" && p.length > 0))
    throw new Error("token: bad payload shape");
  const [customer_id, account_name, segment] = parsed as [string, string, string];
  return { customer_id, account_name, segment };
}
