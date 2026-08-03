// Provider-agnostic tool contract. Each direct-API adapter translates
// these into its own wire dialect (Anthropic `tools`, OpenAI Responses
// `tools`, Gemini `functionDeclarations`) and translates the model's tool
// call requests back into a call to `executeTool`.

import type { AskRequest, PermissionTier } from "../types.js";

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  permission: PermissionTier;
  signal: AbortSignal;
  /** Present only when a human is actually attached and can answer a
   * mid-turn question (the interactive chat TUI). `ask_user_question`
   * degrades to an error result when this is absent. */
  ask?: (request: AskRequest) => Promise<string[]>;
  /** The id of the tool_use/function-call block currently being
   * executed — `ask_user_question` uses it to correlate its request
   * with the eventual out-of-band answer. */
  toolCallId?: string;
}

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  /** Opaque, tool-specific display hints (currently just `run_bash`'s
   * wall time / effective timeout) — passed straight through the
   * `tool_result` event to the TUI, untouched by `executeTool` or any
   * adapter. */
  meta?: Record<string, unknown>;
}
