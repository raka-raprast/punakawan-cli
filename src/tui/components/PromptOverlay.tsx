import { useState } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { TextInput } from "./TextInput.js";

/** Generic "ask one line of text back" overlay — backs every ad hoc
 * question the old REPL used plain `rl.question()` for (login y/n,
 * Anthropic's manually-pasted OAuth code, a free-typed model id, ...).
 * One component instead of bespoke UI per prompt. Escape resolves with
 * `undefined` (distinct from submitting an empty line, which most call
 * sites treat as "keep current"/"decline" too — callers that need a
 * *different* default for a bare Enter, like the login y/n prompt, check
 * for `undefined` explicitly). */
export function PromptOverlay(props: { message: string; onSubmit: (value: string | undefined) => void }): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} paddingX={1}>
      <Text color={theme.accent}>{props.message}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={props.onSubmit} onCancel={() => props.onSubmit(undefined)} />
    </Box>
  );
}
