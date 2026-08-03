import { Box, Text } from "ink";
import type { AgentEvent } from "../../types.js";
import { deriveDisplayBlocks } from "../displayBlocks.js";
import { theme } from "../theme.js";
import { BlockList } from "./BlockList.js";

/** One permanently-rendered turn in the scrollback (`<Static>` item) — the
 * user's message plus everything that happened in response, already
 * finished. Never re-renders once mounted. */
export function TurnView(props: { userText: string; events: AgentEvent[] }): React.JSX.Element {
  const blocks = deriveDisplayBlocks(props.events);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.user}>❯ {props.userText}</Text>
      <BlockList blocks={blocks} />
    </Box>
  );
}
