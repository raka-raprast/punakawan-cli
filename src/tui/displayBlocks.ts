// Turns a turn's raw AgentEvent log into a linear list of display blocks,
// in true chronological order — including text *around* tool calls, not
// just the final answer. The tricky part: every `text` event carries the
// FULL cumulative text so far (by adapter design, so a client that missed
// early deltas can still catch up), not just what's new. The old plain
// readline REPL exploited that by tracking how much of the cumulative
// string it had already written to stdout (`printedLen`) and only ever
// writing the delta. Ink re-renders from a full description of "what the
// screen looks like now" on every state change — there's no stdout cursor
// to carry forward — so the same delta-tracking has to happen here
// instead, against a `blocks` array rather than `process.stdout`.
import type { AgentEvent } from "../types.js";

export type DisplayBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; output: string; isError: boolean; error?: string }
  /** `run_bash`'s `tool_call` + `tool_result` merged into one block, so
   * the command and its output render as a single unit instead of two
   * separate lines. `output`/`durationMs` are absent while the command
   * is still running. */
  | { kind: "bash"; id: string; command: string; timeoutMs?: number; output?: string; isError: boolean; durationMs?: number }
  | { kind: "error"; errKind: string; message: string }
  | { kind: "warning"; message: string };

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

export function deriveDisplayBlocks(events: AgentEvent[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let prevCumulativeText = "";
  // `run_bash` calls awaiting their `tool_result`, indexed by call id, so
  // the result can be merged into the same block instead of appended as
  // a separate one.
  const pendingBash = new Map<string, Extract<DisplayBlock, { kind: "bash" }>>();

  const appendGrowing = (kind: "text" | "reasoning", delta: string): void => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      last.text += delta;
    } else {
      blocks.push({ kind, text: delta } as DisplayBlock);
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "text": {
        const delta = event.text.slice(prevCumulativeText.length);
        prevCumulativeText = event.text;
        if (delta) appendGrowing("text", delta);
        break;
      }
      case "reasoning":
        if (event.text) appendGrowing("reasoning", event.text);
        break;
      case "tool_call":
        if (event.name === "run_bash") {
          const input = event.input as { command?: string; timeout_ms?: number } | undefined;
          const block: Extract<DisplayBlock, { kind: "bash" }> = { kind: "bash", id: event.id, command: input?.command ?? "", timeoutMs: input?.timeout_ms, isError: false };
          pendingBash.set(event.id, block);
          blocks.push(block);
        } else {
          blocks.push({ kind: "tool_call", id: event.id, name: event.name, input: event.input });
        }
        break;
      case "tool_result": {
        const bashBlock = pendingBash.get(event.id);
        if (bashBlock) {
          pendingBash.delete(event.id);
          bashBlock.output = stringifyOutput(event.output);
          bashBlock.isError = event.isError;
          const meta = event.meta as { durationMs?: number; timeoutMs?: number } | undefined;
          if (typeof meta?.durationMs === "number") bashBlock.durationMs = meta.durationMs;
          if (typeof meta?.timeoutMs === "number") bashBlock.timeoutMs = meta.timeoutMs;
        } else {
          blocks.push({ kind: "tool_result", id: event.id, output: stringifyOutput(event.output), isError: event.isError, error: event.error });
        }
        break;
      }
      case "error":
        blocks.push({ kind: "error", errKind: event.kind, message: event.message });
        break;
      case "warning":
        blocks.push({ kind: "warning", message: event.message });
        break;
      case "usage":
      case "started":
      case "turn_complete":
        break;
    }
  }
  return blocks;
}
