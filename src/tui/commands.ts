// Slash-command metadata shared by `/help`, the live "/..." suggestion
// dropdown, and the "did you mean" fallback for a typo'd command — one
// source of truth instead of three places to keep in sync.

export interface CommandSpec {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "connect", usage: "/connect [claude|codex|gemini] [cwd] [model]", description: "pick a backend (↑/↓/Enter if omitted) — session starts on your first message" },
  {
    name: "model",
    usage: "/model [model-id]",
    description:
      "two-pane picker: ↑/↓ browses connected providers, right side live-shows models; →/Enter picks. Switches backend directly, no /connect needed; [model-id] sets on the current backend only",
  },
  { name: "permission", usage: "/permission [safe|edit|full]", description: "show, or set, the active session's permission tier" },
  { name: "init", usage: "/init", description: "scan this repo and write/update AGENTS.md — guidance the model reads on every future turn here" },
  { name: "skills", usage: "/skills", description: "list skills visible to the active (or pending) cwd — global + project-local, from .pkwn/skills/" },
  { name: "new", usage: "/new", description: "fresh conversation, same backend/cwd/model" },
  { name: "clear", usage: "/clear", description: "delete every session (asks to confirm first) — wipes the whole list, not just the active one" },
  { name: "resume", usage: "/resume [session-id]", description: "reattach to an existing session; omit id to pick with ↑/↓/Enter" },
  { name: "sessions", usage: "/sessions", description: "list sessions with titles (* marks the active one)" },
  { name: "schedule", usage: "/schedule <min> <hour> <dom> <month> <dow> <prompt>", description: "create a cron-scheduled automation against the active backend/cwd, e.g. /schedule 0 8 * * * daily build check" },
  { name: "schedules", usage: "/schedules", description: "list cron-scheduled automations and their next fire time" },
  { name: "unschedule", usage: "/unschedule <schedule-id>", description: "delete a scheduled automation" },
  { name: "search", usage: "/search <text>", description: "full-text search across every session's transcript" },
  { name: "stop", usage: "/stop", description: "abort the active session's in-flight turn (Esc does the same thing)" },
  { name: "rm", usage: "/rm [session-id]", description: "delete a session (defaults to active)" },
  { name: "help", usage: "/help", description: "show this list" },
  { name: "exit", aliases: ["quit"], usage: "/exit, /quit", description: "leave (Ctrl-D also works)" },
];

export function allCommandNames(): string[] {
  return COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
}

/** Commands whose name or alias starts with `prefix` (case-insensitive),
 * in declared order. An empty prefix (bare "/") matches every command —
 * that's the whole point of showing the dropdown the instant "/" is typed. */
export function matchCommands(prefix: string): CommandSpec[] {
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p) || (c.aliases ?? []).some((a) => a.startsWith(p)));
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

/** Best guess for a mistyped command name, or `undefined` if nothing's
 * close enough to be worth suggesting — an unrelated word shouldn't get
 * a misleading "did you mean /rm?". Threshold scales with word length so
 * short commands ("/rm") still need a near-exact typo, not just any
 * 1-edit-away word. */
export function suggestCommand(typed: string): string | undefined {
  const t = typed.toLowerCase();
  if (!t) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const name of allCommandNames()) {
    const distance = levenshtein(t, name);
    if (!best || distance < best.distance) best = { name, distance };
  }
  if (!best) return undefined;
  const threshold = Math.max(1, Math.floor(Math.min(t.length, best.name.length) / 2));
  return best.distance <= threshold ? best.name : undefined;
}
