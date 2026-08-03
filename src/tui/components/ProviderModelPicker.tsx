import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BackendId } from "../../types.js";
import { theme } from "../theme.js";

export interface ProviderModels {
  id: BackendId;
  models: Array<{ id: string; displayName?: string; description?: string }>;
}

/** Two-pane provider/model picker: ↑/↓ on the left browses connected
 * providers, the right pane live-updates to that provider's models as
 * you move — no need to commit to a provider before seeing what it
 * offers. →/Enter drills into the model list; ←/Escape backs out (Escape
 * from the provider pane cancels entirely). Only providers the caller
 * already filtered to "logged in" are ever shown here. */
export function ProviderModelPicker(props: {
  providers: ProviderModels[];
  currentBackend?: BackendId;
  onSelect: (result: { backend: BackendId; model: string }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { providers, currentBackend, onSelect, onCancel } = props;
  const [pane, setPane] = useState<"providers" | "models">("providers");
  const [providerCursor, setProviderCursor] = useState(() => {
    const idx = providers.findIndex((p) => p.id === currentBackend);
    return idx >= 0 ? idx : 0;
  });
  const [modelCursor, setModelCursor] = useState(0);

  useEffect(() => {
    setModelCursor(0);
  }, [providerCursor]);

  const provider = providers[providerCursor];
  const modelItems = provider
    ? [
        ...provider.models.map((m) => ({ id: m.id, label: m.displayName ? `${m.id}  — ${m.displayName}` : m.id, description: m.description })),
        { id: "", label: "other — type a model id", description: undefined as string | undefined },
      ]
    : [];

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (pane === "models") {
        setPane("providers");
      } else {
        onCancel();
      }
      return;
    }
    if (pane === "providers") {
      if (key.upArrow) setProviderCursor((c) => (c - 1 + providers.length) % providers.length);
      else if (key.downArrow) setProviderCursor((c) => (c + 1) % providers.length);
      else if (key.rightArrow || key.return) setPane("models");
      return;
    }
    if (key.upArrow) setModelCursor((c) => (c - 1 + modelItems.length) % modelItems.length);
    else if (key.downArrow) setModelCursor((c) => (c + 1) % modelItems.length);
    else if (key.leftArrow) setPane("providers");
    else if (key.return) {
      const item = modelItems[modelCursor];
      if (item && provider) onSelect({ backend: provider.id, model: item.id });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderFocus} paddingX={1}>
      <Text color={theme.accent} bold>
        choose a provider and model
      </Text>
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Box flexDirection="column" minWidth={18}>
          {providers.map((p, i) => (
            <Text key={p.id} color={pane === "providers" && i === providerCursor ? theme.accent : undefined} inverse={pane === "providers" && i === providerCursor}>
              {i === providerCursor ? "❯ " : "  "}
              {p.id}
              {p.id === currentBackend ? " (current)" : ""}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          {modelItems.length === 0 ? (
            <Text color={theme.muted}>(no models found)</Text>
          ) : (
            modelItems.map((m, i) => (
              <Box key={m.id || "other"} flexDirection="column">
                <Text color={pane === "models" && i === modelCursor ? theme.accent : undefined} inverse={pane === "models" && i === modelCursor}>
                  {i === modelCursor ? "❯ " : "  "}
                  {m.label}
                </Text>
                {m.description ? (
                  <Text color={theme.muted}>
                    {"    "}
                    {m.description}
                  </Text>
                ) : null}
              </Box>
            ))
          )}
        </Box>
      </Box>
      <Text color={theme.muted}>↑/↓ move · →/Enter drill in · ← back · Esc cancel</Text>
    </Box>
  );
}
