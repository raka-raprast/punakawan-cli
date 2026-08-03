// PKCE (RFC 7636) helpers shared by every direct-OAuth backend adapter —
// Anthropic, OpenAI/Codex, and Google/Gemini all use an authorization-code +
// PKCE flow for their native-app (CLI) OAuth clients, so there's no
// per-provider variation here worth duplicating.

import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}
