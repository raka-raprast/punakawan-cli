import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import type { SelectItem } from "./SelectList.js";
import { TextInput } from "./TextInput.js";

/** Renders the model's `ask_user_question` tool call as an interactive
 * picker — arrow keys move, Enter confirms, Space toggles a checkbox when
 * `allowMultiple`, Escape submits an empty answer (the tool reports the
 * question was dismissed and the model proceeds on its own judgement).
 * A synthetic "Other" row is always appended, mirroring omp's own `ask`
 * tool: picking it drops into a free-text prompt instead of one of the
 * model's fixed options, for when none of them actually fit. */
export function AskOverlay(props: { question: string; options: SelectItem<string>[]; allowMultiple: boolean; onSubmit: (answer: string[]) => void }): React.JSX.Element {
  const { question, options, allowMultiple, onSubmit } = props;
  const otherIndex = options.length;
  const rowCount = options.length + 1;
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // Set only while typing the "Other" answer — carries the already-picked
  // regular labels (multi-select) so they merge with the typed text
  // instead of being lost.
  const [customBase, setCustomBase] = useState<string[] | undefined>(undefined);
  const [customValue, setCustomValue] = useState("");

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor((c) => (c - 1 + rowCount) % rowCount);
      else if (key.downArrow) setCursor((c) => (c + 1) % rowCount);
      else if (allowMultiple && input === " ") {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
      } else if (key.return) {
        const picked = allowMultiple ? (checked.size > 0 ? [...checked] : [cursor]) : [cursor];
        if (picked.includes(otherIndex)) {
          setCustomBase(picked.filter((i) => i !== otherIndex).map((i) => options[i]!.value));
        } else {
          onSubmit(picked.map((i) => options[i]!.value));
        }
      } else if (key.escape || (key.ctrl && input === "c")) {
        onSubmit([]);
      }
    },
    { isActive: customBase === undefined },
  );

  if (customBase !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} paddingX={1}>
        <Text color={theme.accent} bold>
          ? {question}
        </Text>
        <TextInput
          value={customValue}
          onChange={setCustomValue}
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              setCustomBase(undefined); // nothing typed — back to the list, keep prior selection
              return;
            }
            onSubmit([...customBase, trimmed]);
          }}
          onCancel={() => setCustomBase(undefined)}
          prompt="your answer: "
        />
        <Text color={theme.muted}>Enter submit · Esc back to options</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} paddingX={1}>
      <Text color={theme.accent} bold>
        ? {question}
      </Text>
      {options.map((item, i) => (
        <Box key={i} flexDirection="column">
          <Text color={i === cursor ? theme.accent : undefined} inverse={i === cursor}>
            {i === cursor ? "❯ " : "  "}
            {allowMultiple ? (checked.has(i) ? "[x] " : "[ ] ") : ""}
            {item.label}
          </Text>
          {item.description ? (
            <Text color={theme.muted}>
              {"    "}
              {item.description}
            </Text>
          ) : null}
        </Box>
      ))}
      <Text color={otherIndex === cursor ? theme.accent : theme.muted} inverse={otherIndex === cursor} italic={otherIndex !== cursor}>
        {otherIndex === cursor ? "❯ " : "  "}
        {allowMultiple ? (checked.has(otherIndex) ? "[x] " : "[ ] ") : ""}
        Other (type your own)
      </Text>
      <Text color={theme.muted}>{allowMultiple ? "↑/↓ move · Space toggle · Enter confirm · Esc skip" : "↑/↓ move · Enter select · Esc skip"}</Text>
    </Box>
  );
}
