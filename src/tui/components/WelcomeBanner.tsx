import { Box, Text } from "ink";
import { basename } from "node:path";
import type { BackendId } from "../../types.js";
import type { AuthStatusEntry, SessionMetaResponse } from "../../cli-shared.js";
import { PKWN_VERSION } from "../../version.js";
import { theme } from "../theme.js";
import { hueToHex } from "../colors.js";

// A wayang-kulit mask silhouette — Punakawan are the clown-servant
// puppet characters this project is named after — kept deliberately
// distinct from a plain logo mark: eyes, nose, mouth, and the puppet's
// handle beneath it. Lines needn't be perfectly rectangular; monospace
// block glyphs read fine ragged.
const LOGO_LINES = ["  ▄▄▄▄▄▄▄  ", " █▀▀▀▀▀▀▀█ ", " █ ◉   ◉ █ ", " █   ▽   █ ", " █ ╰───╯ █ ", " █▄▄▄▄▄▄▄█ ", "    █ █    ", "   ▄█ █▄   ", "  █▀▀▀▀▀█  ", "  ▀▀▀▀▀▀▀  "];

const TIPS = ["Type a message to start chatting", "/connect to pick a backend", "/model, /permission to adjust", "/resume to reattach a session", "/help for every command"];

/** Prints once, permanently, as the first entry in the chat's `<Static>`
 * scrollback — NOT a live-redrawing component. Ink's `<Static>` output
 * always appears above whatever's still live, regardless of JSX order;
 * a component with its own timer here would keep re-rendering forever
 * while the conversation grows underneath it, visually drifting further
 * down and getting corrupted every time a turn finalizes. `baseHue` is
 * chosen once by the caller (so it's stable across re-renders of this
 * already-committed item) — the rainbow sweep across the mask is a
 * fixed, per-launch snapshot rather than a continuous animation. */
export function WelcomeBanner(props: { baseHue: number; backend?: BackendId; model?: string; authStatuses: AuthStatusEntry[]; recentSessions: SessionMetaResponse[] }): React.JSX.Element {
  const { baseHue, backend, model, authStatuses, recentSessions } = props;
  const recent = [...recentSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.muted}>
        --- pkwn v{PKWN_VERSION} {"-".repeat(40)}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor={theme.border} paddingX={2} width={28}>
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color={hueToHex(baseHue + i * 24)} bold>
              {line}
            </Text>
          ))}
          <Text> </Text>
          <Text bold color={theme.accent}>
            {backend ? "Welcome back!" : "Welcome!"}
          </Text>
          {backend ? (
            <>
              <Text color={theme.assistant}>{model ?? "default model"}</Text>
              <Text color={theme.muted}>{backend}</Text>
            </>
          ) : null}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={2} flexGrow={1}>
          <Text bold color={theme.accent}>
            Tips
          </Text>
          {TIPS.map((tip, i) => (
            <Text key={i} color={theme.muted}>
              {tip}
            </Text>
          ))}
          <Text color={theme.border}>{"-".repeat(40)}</Text>
          <Text bold color={theme.accent}>
            Backends
          </Text>
          {authStatuses.length === 0 ? (
            <Text color={theme.muted}>no backends configured</Text>
          ) : (
            <Text>
              {authStatuses.map((a, i) => (
                <Text key={a.backend} color={a.loggedIn ? theme.success : theme.muted}>
                  {i > 0 ? "   " : ""}
                  {a.loggedIn ? "✓" : "✗"} {a.backend}
                </Text>
              ))}
            </Text>
          )}
          <Text color={theme.border}>{"-".repeat(40)}</Text>
          <Text bold color={theme.accent}>
            Recent sessions
          </Text>
          {recent.length === 0 ? (
            <Text color={theme.muted}>No recent sessions</Text>
          ) : (
            recent.map((s) => (
              <Text key={s.id} color={theme.muted}>
                {s.id.slice(0, 8)} {s.backend.padEnd(7)} {basename(s.cwd)}
                {s.title ? ` — ${s.title}` : ""}
              </Text>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}
