import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

/** Single-line, controlled, cursor-aware input. `history` (most-recent
 * last, shell-style) is browsed with Up/Down when not mid-edit — mirrors
 * every shell's up-arrow-recalls-last-command muscle memory that the old
 * plain readline REPL got "for free"; Ink owns the terminal now, so it has
 * to be reimplemented explicitly. */
export function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  history?: string[];
  prompt?: string;
  isActive?: boolean;
  /** Full replacement text Tab accepts (e.g. `"/connect "`) — the
   * currently highlighted hit from a live suggestion list shown
   * alongside this input. */
  suggestion?: string;
  /** Present exactly when a suggestion list is showing — reroutes ↑/↓
   * (normally history recall) into moving the highlight, and Enter
   * (normally submit) into running the highlighted command directly,
   * for as long as this is set. */
  suggestionNav?: { count: number; onMove: (delta: 1 | -1) => void; onAccept: () => void };
}): React.JSX.Element {
  const { value, onChange, onSubmit, onCancel, history = [], prompt = "", isActive = true, suggestion, suggestionNav } = props;
  const [cursor, setCursor] = useState(value.length);
  // null = editing a fresh (non-history) value; otherwise an index into
  // `history`, counting back from the end.
  const historyIndex = useRef<number | null>(null);
  const draftBeforeHistory = useRef("");

  // Keep the cursor in bounds whenever the controlled value changes out
  // from under us (e.g. the parent clears it after submit).
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.return) {
        if (suggestionNav && suggestionNav.count > 0) {
          suggestionNav.onAccept();
          return;
        }
        historyIndex.current = null;
        onSubmit(value);
        return;
      }
      if (key.tab) {
        if (suggestion !== undefined) {
          onChange(suggestion);
          setCursor(suggestion.length);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.upArrow) {
        if (suggestionNav && suggestionNav.count > 0) {
          suggestionNav.onMove(-1);
          return;
        }
        if (history.length === 0) return;
        if (historyIndex.current === null) draftBeforeHistory.current = value;
        const next = historyIndex.current === null ? history.length - 1 : Math.max(0, historyIndex.current - 1);
        historyIndex.current = next;
        const recalled = history[next] ?? "";
        onChange(recalled);
        setCursor(recalled.length);
        return;
      }
      if (key.downArrow) {
        if (suggestionNav && suggestionNav.count > 0) {
          suggestionNav.onMove(1);
          return;
        }
        if (historyIndex.current === null) return;
        const next = historyIndex.current + 1;
        if (next >= history.length) {
          historyIndex.current = null;
          onChange(draftBeforeHistory.current);
          setCursor(draftBeforeHistory.current.length);
        } else {
          historyIndex.current = next;
          const recalled = history[next] ?? "";
          onChange(recalled);
          setCursor(recalled.length);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((c) => c - 1);
        historyIndex.current = null;
        return;
      }
      if (key.ctrl || key.meta) return;
      if (!input) return;
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor((c) => c + input.length);
      historyIndex.current = null;
    },
    { isActive },
  );

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);

  return (
    <Box>
      <Text color={theme.accent}>{prompt}</Text>
      <Text>{before}</Text>
      {isActive ? <Text inverse>{at}</Text> : <Text>{at === " " ? "" : at}</Text>}
      <Text>{after}</Text>
    </Box>
  );
}
