import { Box, Text } from "ink";
import type { DisplayBlock } from "../displayBlocks.js";
import { theme } from "../theme.js";
import { DiffText } from "./DiffText.js";

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function renderBlock(block: DisplayBlock, key: number): React.JSX.Element {
  switch (block.kind) {
    case "text":
      return (
        <Text key={key} color={theme.assistant}>
          {block.text}
        </Text>
      );
    case "reasoning":
      return (
        <Text key={key} color={theme.muted} italic dimColor>
          {block.text}
        </Text>
      );
    case "tool_call":
      if (block.name === "ask_user_question") {
        const input = block.input as { question?: string; options?: Array<{ label?: string }> } | undefined;
        const labels = (input?.options ?? []).map((o) => o?.label).filter((l): l is string => typeof l === "string");
        return (
          <Text key={key} color={theme.toolName}>
            {"  ? "}
            {input?.question ?? "(question)"} {labels.length > 0 ? `[${labels.join(" / ")}]` : ""}
          </Text>
        );
      }
      return (
        <Text key={key} color={theme.toolName}>
          {"  → "}
          {block.name}({JSON.stringify(block.input).slice(0, 200)})
        </Text>
      );
    case "bash": {
      const footerParts = [block.durationMs !== undefined ? `Wall: ${formatSeconds(block.durationMs)}` : undefined, block.timeoutMs !== undefined ? `Timeout: ${formatSeconds(block.timeoutMs)}` : undefined].filter(
        (p): p is string => p !== undefined,
      );
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={block.output === undefined ? theme.border : block.isError ? theme.error : theme.success} backgroundColor={theme.codeBg} paddingX={1}>
          <Text bold color={theme.accent}>
            $ {block.command}
          </Text>
          {block.output !== undefined ? (
            <>
              <Text color={theme.muted}>{"─".repeat(10)} output {"─".repeat(10)}</Text>
              <Text color={block.isError ? theme.error : theme.assistant}>{block.output}</Text>
              {footerParts.length > 0 ? <Text color={theme.muted}>[{footerParts.join(" | ")}]</Text> : null}
            </>
          ) : (
            <Text color={theme.muted}>running…</Text>
          )}
        </Box>
      );
    }
    case "tool_result":
      return (
        <Box key={key} flexDirection="column" paddingLeft={2}>
          <Text color={block.isError ? theme.error : theme.success}>{block.isError ? "✗ tool error" : "✓ tool result"}</Text>
          <Box paddingLeft={2}>
            <DiffText text={block.isError ? block.error ?? block.output : block.output} />
          </Box>
        </Box>
      );
    case "error":
      return (
        <Text key={key} color={theme.error}>
          ! error ({block.errKind}): {block.message}
        </Text>
      );
    case "warning":
      return (
        <Text key={key} color={theme.warning}>
          ! {block.message}
        </Text>
      );
  }
}

export function BlockList(props: { blocks: DisplayBlock[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.blocks.map((block, i) => renderBlock(block, i))}
    </Box>
  );
}
