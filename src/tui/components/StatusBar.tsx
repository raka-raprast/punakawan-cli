import { Box, Text } from "ink";
import type { BackendId, PermissionTier } from "../../types.js";
import { theme } from "../theme.js";

export function StatusBar(props: {
  backend?: BackendId;
  model?: string;
  permission?: PermissionTier;
  folder?: string;
  isActive: boolean;
}): React.JSX.Element {
  const { backend, model, permission, folder, isActive } = props;
  if (!backend) {
    return (
      <Box>
        <Text color={theme.muted}>○ no backend selected — type a message or /connect</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={isActive ? theme.success : theme.warning}>{isActive ? "●" : "○"} </Text>
      <Text color={theme.accent} bold>
        {backend}:{model ?? "default"}
      </Text>
      <Text color={theme.muted}>
        {" @ "}
        {folder}
        {permission ? ` [${permission}]` : ""}
      </Text>
    </Box>
  );
}
