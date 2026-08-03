import { Box, Text } from "ink";
import { theme } from "../theme.js";

/** Colors a `write_file`/`edit_file` tool result's diff output line by
 * line — a full-width dark-green/dark-red background band per `+`/`-`
 * line (not just colored text) so changed lines actually pop out, plus
 * a black backdrop behind the whole block so it reads as a distinct code
 * region regardless of the user's terminal theme. Falls back to
 * rendering unrecognized text as-is (a diff-shaped heuristic, not a
 * strict parser: anything not starting with `---` is still just plain
 * output for tools that aren't a file diff). */
export function DiffText(props: { text: string }): React.JSX.Element {
  const lines = props.text.split("\n");
  const looksLikeDiff = lines[0]?.startsWith("--- ");
  if (!looksLikeDiff) {
    return (
      <Box flexDirection="column" backgroundColor={theme.codeBg} paddingX={1}>
        <Text>{props.text}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" backgroundColor={theme.codeBg} paddingX={1}>
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return (
            <Text key={i} color={theme.diffHeader}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={i} color={theme.accent} dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("+")) {
          return (
            <Box key={i} backgroundColor={theme.diffAddBg}>
              <Text color={theme.diffAdd}>{line}</Text>
            </Box>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Box key={i} backgroundColor={theme.diffDelBg}>
              <Text color={theme.diffDel}>{line}</Text>
            </Box>
          );
        }
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}
