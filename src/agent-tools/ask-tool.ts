// Interactive clarifying-question tool: lets the model pause a turn and
// hand a fixed set of options to whoever's attached to the session (the
// chat TUI), instead of guessing or dumping the choice into plain
// assistant text the way models otherwise do. Available at every
// permission tier — asking a question is never destructive.

import type { AskOption, AskRequest } from "../types.js";
import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./types.js";

export const askUserQuestionTool: ToolDefinition = {
  name: "ask_user_question",
  description:
    "Ask the human user a clarifying question with a fixed set of selectable options, and pause until they answer. " +
    "Use this when there are genuinely multiple reasonable ways to proceed and the choice meaningfully changes the " +
    "work (which stack, which scope, destructive vs. safe, ...) — not for things you can figure out yourself from " +
    "the repo. Prefer a short list of concrete options over asking the user to type free text.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to show the user." },
      options: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short option text, shown as a pickable line." },
            description: { type: "string", description: "Optional one-line elaboration shown under the label." },
          },
          required: ["label"],
        },
      },
      allowMultiple: { type: "boolean", description: "Allow picking more than one option (default false)." },
    },
    required: ["question", "options"],
  },
};

/** Races `ctx.ask`'s answer against `ctx.signal` so a question nobody
 * can ever answer (no interactive client attached, or one that
 * disconnected without triggering `cancelPendingAsks`) still resolves —
 * on the session's own abort (`/stop`) or its turn timeout, both of
 * which already feed into `ctx.signal` — rather than hanging the turn
 * indefinitely. */
function waitForAnswer(ask: NonNullable<ToolContext["ask"]>, request: AskRequest, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) return Promise.reject(new Error("turn aborted before the question could be answered"));
  return new Promise<string[]>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("turn aborted while waiting for the user's answer"));
    signal.addEventListener("abort", onAbort, { once: true });
    ask(request).then(
      (answer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function runAskUserQuestion(input: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
  const args = input as { question?: string; options?: Array<{ label?: string; description?: string }>; allowMultiple?: boolean };
  if (!args.question) return { output: "error: missing required 'question'", isError: true };
  const options: AskOption[] = (args.options ?? []).filter((o): o is AskOption => typeof o?.label === "string" && o.label.length > 0);
  if (options.length === 0) return { output: "error: 'options' must contain at least one item with a non-empty 'label'", isError: true };

  if (!ctx.ask) {
    return {
      output: "error: ask_user_question is unavailable in this context (no interactive user attached) — proceed with your own best judgement and state the assumption you made",
      isError: true,
    };
  }

  const request: AskRequest = { id: ctx.toolCallId ?? "", question: args.question, options, allowMultiple: args.allowMultiple === true };
  try {
    const answer = await waitForAnswer(ctx.ask, request, ctx.signal);
    if (answer.length === 0) {
      return { output: "the user dismissed the question without answering — proceed with your own best judgement", isError: false };
    }
    return { output: `user chose: ${answer.join(", ")}`, isError: false };
  } catch (err) {
    return { output: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
