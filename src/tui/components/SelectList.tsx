import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

export interface SelectItem<T> {
  label: string;
  value: T;
  /** Rendered dimmed below the label, e.g. a login-status hint. */
  description?: string;
}

/** Arrow-key overlay picker — Up/Down move, Enter selects, Escape/Ctrl+C
 * cancels. Used for every "pick one of these" moment (`/connect`'s backend
 * picker, `/model`, `/resume`'s session list, ...) instead of the old
 * readline-scrollback-based menu. */
export function SelectList<T>(props: {
  title: string;
  items: Array<SelectItem<T>>;
  onSelect: (value: T) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { title, items, onSelect, onCancel } = props;
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => (c - 1 + items.length) % items.length);
    else if (key.downArrow) setCursor((c) => (c + 1) % items.length);
    else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.value);
    } else if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      {items.length === 0 ? (
        <Text color={theme.muted}>(nothing to pick from)</Text>
      ) : (
        items.map((item, i) => (
          <Box key={i} flexDirection="column">
            <Text color={i === cursor ? theme.accent : undefined} inverse={i === cursor}>
              {i === cursor ? "❯ " : "  "}
              {item.label}
            </Text>
            {item.description ? (
              <Text color={theme.muted}>
                {"    "}
                {item.description}
              </Text>
            ) : null}
          </Box>
        ))
      )}
      <Text color={theme.muted}>↑/↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}
