import { Semaphore } from "../process/semaphore.js";
import type { BackendAdapter, BackendId } from "../types.js";
import type { PkwnConfig } from "../config.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { GeminiAdapter } from "./gemini.js";

export interface RegisteredBackend {
  adapter: BackendAdapter;
  semaphore: Semaphore;
  homeDir?: string;
  defaultModel?: string;
}

export class BackendRegistry {
  private readonly backends: Record<BackendId, RegisteredBackend>;

  constructor(config: PkwnConfig, adapters?: BackendAdapter[]) {
    const build = (adapter: BackendAdapter): RegisteredBackend => {
      const override = config.backends[adapter.id];
      return {
        adapter,
        semaphore: new Semaphore(override?.maxConcurrency ?? adapter.defaultMaxConcurrency),
        homeDir: override?.homeDir,
        defaultModel: override?.defaultModel,
      };
    };
    const chosen = adapters ?? [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()];
    // Object.fromEntries loses the key-union type; we know it's exactly
    // BackendId because that's what adapter.id is typed as above.
    this.backends = Object.fromEntries(chosen.map((a) => [a.id, build(a)])) as Record<BackendId, RegisteredBackend>;
  }

  get(id: BackendId): RegisteredBackend {
    const backend = this.backends[id];
    if (!backend) throw new Error(`unknown backend "${id}"`);
    return backend;
  }

  list(): RegisteredBackend[] {
    return Object.values(this.backends);
  }
}
