// Minimal cookie jar for the Cloudflare bot-mitigation cookies in front of
// chatgpt.com/backend-api. Codex CLI's own HTTP client persists and
// replays exactly this allow-list across requests to avoid Cloudflare
// challenge/blocking (source: codex-rs/http-client/src/chatgpt_cloudflare_cookies.rs).
// This is NOT a general-purpose cookie jar — it deliberately never stores
// anything else (in particular, no ChatGPT session/account cookies).

const CLOUDFLARE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

function isCloudflareCookie(name: string): boolean {
  return CLOUDFLARE_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_");
}

export class CloudflareCookieJar {
  private readonly cookies = new Map<string, string>();

  /** Parses `Set-Cookie` response headers and keeps only the Cloudflare
   * allow-list entries. */
  absorb(headers: Headers): void {
    for (const raw of headers.getSetCookie?.() ?? []) {
      const eq = raw.indexOf("=");
      if (eq <= 0) continue;
      const name = raw.slice(0, eq).trim();
      const rest = raw.slice(eq + 1);
      const value = rest.split(";", 1)[0]?.trim();
      if (value && isCloudflareCookie(name)) this.cookies.set(name, value);
    }
  }

  /** `Cookie:` header value for the next request, or undefined if empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}
