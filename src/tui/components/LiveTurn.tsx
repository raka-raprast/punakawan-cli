import { Box, Text } from "ink";
import type { AgentEvent } from "../../types.js";
import { deriveDisplayBlocks } from "../displayBlocks.js";
import { theme } from "../theme.js";
import { BlockList } from "./BlockList.js";
import { Spinner } from "./Spinner.js";

/** The in-flight turn — re-renders on every new event until `turn_complete`
 * moves it into permanent scrollback (see reducer). */
export function LiveTurn(props: { userText: string; events: AgentEvent[] }): React.JSX.Element {
  const blocks = deriveDisplayBlocks(props.events);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.user}>❯ {props.userText}</Text>
      <BlockList blocks={blocks} />
      <Spinner label="working…" />
    </Box>
  );
}
