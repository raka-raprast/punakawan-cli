// Shared color palette for the chat TUI — kept in one place so every
// component agrees on what "assistant text" or "an error" looks like.
export const theme = {
  accent: "cyan",
  muted: "gray",
  success: "green",
  error: "red",
  warning: "yellow",
  user: "blueBright",
  assistant: "white",
  toolName: "magenta",
  diffAdd: "greenBright",
  diffDel: "redBright",
  diffAddBg: "#123a1c",
  diffDelBg: "#3a1414",
  diffHeader: "gray",
  border: "gray",
  borderFocus: "cyan",
  /** Black backdrop for code/command blocks (diffs, `run_bash` output) —
   * visually separates them from surrounding chat prose regardless of
   * the user's own terminal theme. */
  codeBg: "black",
} as const;

// A filled, rounder "spinning ball" braille pattern (cli-spinners' "dots2")
// instead of the thinner dot-cycle default — reads better once colorized,
// since more of each glyph actually carries the color.
export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
// 150ms (not the more typical 80ms) deliberately — every tick forces a full
// repaint of the live region regardless of whether the model actually
// produced anything new, stacking on top of the streaming text's own
// repaints. Halving the tick rate visibly reduces flicker during active
// generation without looking sluggish.
export const SPINNER_INTERVAL_MS = 150;
