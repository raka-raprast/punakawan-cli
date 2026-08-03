import { Box, Text } from "ink";
import type { CommandSpec } from "../commands.js";
import { theme } from "../theme.js";

/** Live "/..." autocomplete dropdown — shown the instant the input starts
 * with "/" and the command name isn't finished yet (no space typed after
 * it). `highlightedIndex` (moved with ↑/↓, owned by the parent so it can
 * also drive what Tab/Enter do) marks which match Tab completes to and
 * Enter runs directly. */
export function CommandSuggestions(props: { matches: CommandSpec[]; highlightedIndex: number }): React.JSX.Element | null {
  const { matches, highlightedIndex } = props;
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {matches.map((c, i) => (
        <Text key={c.name} color={i === highlightedIndex ? theme.accent : theme.muted} bold={i === highlightedIndex}>
          {i === highlightedIndex ? "❯ " : "  "}
          {c.usage.padEnd(44)}
          <Text color={theme.muted}> {c.description}</Text>
        </Text>
      ))}
      <Text color={theme.muted}>↑/↓ move · Tab complete · Enter run · keep typing to narrow down</Text>
    </Box>
  );
}
