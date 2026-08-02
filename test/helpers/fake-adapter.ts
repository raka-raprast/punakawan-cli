import type { AgentEvent, AuthStatus, BackendAdapter, BackendId, TurnOptions } from "../../src/types.js";

/** In-process fake backend: no subprocess, fully scripted event sequences
 * per call. Lets session-manager / API tests exercise retry, concurrency,
 * and streaming logic deterministically without a real CLI installed. */
export class FakeAdapter implements BackendAdapter {
  readonly id: BackendId;
  readonly displayName = "Fake Backend";
  readonly defaultMaxConcurrency = 2;
  callCount = 0;
  authResult: AuthStatus;

  /** Each call to runTurn consumes the next scripted response (or repeats
   * the last one if the script is shorter than the number of calls). */
  script: Array<(opts: TurnOptions) => AsyncGenerator<AgentEvent, void, void>> = [];

  constructor(id: BackendId = "claude") {
    this.id = id;
    this.authResult = { backend: id, loggedIn: true, mode: "oauth-subscription" };
  }

  async checkAuth(): Promise<AuthStatus> {
    return this.authResult;
  }

  async *runTurn(opts: TurnOptions): AsyncGenerator<AgentEvent, void, void> {
    this.callCount++;
    const step = this.script[Math.min(this.callCount - 1, this.script.length - 1)];
    if (!step) throw new Error("FakeAdapter.script is empty");
    yield* step(opts);
  }
}

export async function* successTurn(text: string): AsyncGenerator<AgentEvent, void, void> {
  yield { type: "started", backendSessionId: "fake-session-1" };
  yield { type: "text", role: "assistant", text: text.slice(0, 1), partial: true };
  yield { type: "text", role: "assistant", text, partial: false };
  yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  yield { type: "turn_complete", ok: true };
}

export async function* rateLimitedTurn(): AsyncGenerator<AgentEvent, void, void> {
  yield { type: "started", backendSessionId: "fake-session-1" };
  yield { type: "error", kind: "rate_limit", message: "usage limit reached", retryable: true };
  yield { type: "turn_complete", ok: false };
}

export async function* crashOnceTurn(): AsyncGenerator<AgentEvent, void, void> {
  yield { type: "error", kind: "crash", message: "simulated transient crash", retryable: true };
  yield { type: "turn_complete", ok: false };
}
