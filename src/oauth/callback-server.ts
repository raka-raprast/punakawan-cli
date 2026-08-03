// Local HTTP listener for the OAuth authorization-code callback. Every
// provider's native-app OAuth client redirects to a `localhost:<port>` URL
// after consent — this is the one piece of the flow that's identical
// across Anthropic/OpenAI/Google, so it's shared rather than reimplemented
// per adapter.

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";

/** Binds to port 0 (OS picks a free ephemeral port), reads it back, and
 * releases it immediately — the standard practical approach (same one
 * gemini-cli's own `getAvailablePort()` uses) despite the inherent
 * TOCTOU race between releasing and re-binding for the real callback
 * server. Only used by providers whose OAuth client allow-lists arbitrary
 * loopback ports; Codex's redirect URI is allow-listed to two fixed ports
 * server-side and must not use this. */
export async function findAvailablePort(): Promise<number> {
  const probe = createNetServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : undefined;
    probe.close(() => (port ? resolve(port) : reject(new Error("could not determine bound port"))));
  });
  return promise;
}

/** Tests whether this EXACT port (not an OS-assigned one) can be bound —
 * needed for providers like Codex whose OAuth client only allow-lists a
 * couple of fixed redirect ports, where an arbitrary free port is useless. */
export async function isPortAvailable(port: number): Promise<boolean> {
  const probe = createNetServer();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  probe.once("error", () => resolve(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  return promise;
}

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

/** Listens on `127.0.0.1:<port>` for exactly one OAuth redirect carrying
 * `?code=...&state=...` (or `?error=...`), resolves with the code, and
 * shuts the server down. The browser tab gets a plain "you can close this"
 * page — pkwn's own terminal is what's actually waiting. */
export async function waitForOAuthCallback(opts: {
  port: number;
  path?: string;
  timeoutMs?: number;
  successHtml?: string;
}): Promise<OAuthCallbackResult> {
  const path = opts.path ?? "/";
  const { promise: result, resolve, reject } = Promise.withResolvers<OAuthCallbackResult>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state") ?? undefined;

    if (error) {
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`);
      reject(new Error(`oauth callback error: ${error}`));
    } else if (code) {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(opts.successHtml ?? "<html><body>Signed in — you can close this tab and return to the terminal.</body></html>");
      resolve({ code, state });
    } else {
      res.writeHead(400).end();
      return;
    }
    setImmediate(() => server.close());
  });

  const { promise: listening, resolve: resolveListening, reject: rejectListening } = Promise.withResolvers<void>();
  server.once("error", rejectListening);
  server.listen(opts.port, "127.0.0.1", resolveListening);
  await listening;

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        server.close();
        reject(new Error(`timed out after ${opts.timeoutMs}ms waiting for the OAuth redirect`));
      }, opts.timeoutMs)
    : undefined;
  try {
    return await result;
  } finally {
    clearTimeout(timer);
  }
}
