// The chat TUI's whole state machine and layout. Ports every `/`-command
// and the plain-message send path from the old readline-based REPL 1:1,
// just against Ink state instead of mutable `let`s and `console.log`.
import { useEffect, useRef, useState } from "react";
import { useReducer } from "react";
import { basename } from "node:path";
import { Box, Static, Text, useApp, useInput } from "ink";
import { WebSocket } from "ws";
import { loadConfig } from "../config.js";
import type { PkwnConfig } from "../config.js";
import type { AgentEvent, BackendId, PermissionTier } from "../types.js";
import {
  apiRequest,
  ensureDaemonRunning,
  isBackendId,
  loginBackend,
  readLastUsed,
  transcriptToTurns,
  writeLastUsed,
  type AuthStatusEntry,
  type AuthStatusResponse,
  type ModelInfoResponse,
  type ModelsResponse,
  type SearchResponse,
  type SessionListResponse,
  type SessionMetaResponse,
} from "../cli-shared.js";
import { theme } from "./theme.js";
import { TurnView } from "./components/TurnView.js";
import { LiveTurn } from "./components/LiveTurn.js";
import { StatusBar } from "./components/StatusBar.js";
import { TextInput } from "./components/TextInput.js";
import { SelectList, type SelectItem } from "./components/SelectList.js";
import { PromptOverlay } from "./components/PromptOverlay.js";
import { ProviderModelPicker, type ProviderModels } from "./components/ProviderModelPicker.js";
import { AskOverlay } from "./components/AskOverlay.js";
import { WelcomeBanner } from "./components/WelcomeBanner.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { COMMANDS, matchCommands, suggestCommand } from "./commands.js";

const BACKEND_ORDER: BackendId[] = ["claude", "codex", "gemini"];

let nextScrollbackId = 0;

export type ScrollbackItem =
  | { kind: "system"; id: number; text: string; tone: "info" | "error" | "success" }
  | { kind: "turn"; id: number; userText: string; events: AgentEvent[] }
  | { kind: "welcome"; id: number; baseHue: number; backend?: BackendId; model?: string; authStatuses: AuthStatusEntry[]; recentSessions: SessionMetaResponse[] };

export interface ChatState {
  activeId?: string;
  activeBackend?: BackendId;
  activeModel?: string;
  activeCwd?: string;
  activePermission?: PermissionTier;
  pendingBackend?: BackendId;
  pendingModel?: string;
  pendingPermission?: PermissionTier;
  pendingCwd?: string;
  scrollback: ScrollbackItem[];
  /** Bumped every time `scrollback` is wholesale-replaced (LOAD_SCROLLBACK,
   * CLEAR_SCROLLBACK) rather than appended to. Ink's `<Static>` only
   * tracks *how many* items it's already printed, not their identity —
   * if a replacement array happens to land on the same length as before,
   * `<Static>` silently treats the whole new array as "already shown"
   * and prints nothing. Using this as `<Static>`'s `key` forces React to
   * remount it (fresh internal counter) on every such replace, so a
   * length coincidence can never again make replayed/cleared history
   * vanish. */
  scrollbackGeneration: number;
  liveTurn?: { userText: string; events: AgentEvent[] };
  /** Plain messages submitted while a turn is already in flight — held
   * here instead of sent immediately (which would overwrite `liveTurn`
   * mid-stream and mix the in-flight turn's remaining events under the
   * wrong label). Drained one at a time once `liveTurn` clears; the
   * daemon already serializes turns on a session regardless, this just
   * keeps the *client's* live display honest while that happens. */
  queuedMessages: string[];
}

export type Action =
  | { type: "SET_ACTIVE"; meta: SessionMetaResponse | undefined }
  | { type: "SET_PENDING"; backend: BackendId; model?: string; permission: PermissionTier; cwd: string }
  | { type: "PATCH_ACTIVE_META"; model?: string; permission?: PermissionTier }
  | { type: "PATCH_PENDING"; model?: string; permission?: PermissionTier }
  | { type: "START_TURN"; userText: string }
  | { type: "AGENT_EVENT"; event: AgentEvent }
  | { type: "LOAD_SCROLLBACK"; turns: Array<{ userText: string; events: AgentEvent[] }> }
  | { type: "SHOW_WELCOME"; baseHue: number; backend?: BackendId; model?: string; authStatuses: AuthStatusEntry[]; recentSessions: SessionMetaResponse[] }
  | { type: "QUEUE_MESSAGE"; text: string }
  | { type: "DEQUEUE_MESSAGE" }
  | { type: "CLEAR_SCROLLBACK" }
  | { type: "SYSTEM_MESSAGE"; text: string; tone?: "info" | "error" | "success" };

export const initialState: ChatState = { scrollback: [], scrollbackGeneration: 0, queuedMessages: [] };

export function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "SET_ACTIVE": {
      const meta = action.meta;
      if (!meta) {
        return { ...state, activeId: undefined, activeBackend: undefined, activeModel: undefined, activeCwd: undefined, activePermission: undefined, liveTurn: undefined, queuedMessages: [] };
      }
      return {
        ...state,
        activeId: meta.id,
        activeBackend: meta.backend,
        activeModel: meta.model,
        activeCwd: meta.cwd,
        activePermission: meta.permission,
        pendingBackend: undefined,
        pendingModel: undefined,
        pendingPermission: undefined,
        pendingCwd: undefined,
        liveTurn: undefined,
        queuedMessages: [],
      };
    }
    case "SET_PENDING":
      return {
        ...state,
        activeId: undefined,
        activeBackend: undefined,
        activeModel: undefined,
        activeCwd: undefined,
        activePermission: undefined,
        pendingBackend: action.backend,
        pendingModel: action.model,
        pendingPermission: action.permission,
        pendingCwd: action.cwd,
        liveTurn: undefined,
        queuedMessages: [],
      };
    case "PATCH_ACTIVE_META":
      return { ...state, activeModel: action.model ?? state.activeModel, activePermission: action.permission ?? state.activePermission };
    case "PATCH_PENDING":
      return { ...state, pendingModel: action.model ?? state.pendingModel, pendingPermission: action.permission ?? state.pendingPermission };
    case "START_TURN":
      return { ...state, liveTurn: { userText: action.userText, events: [] } };
    case "AGENT_EVENT": {
      if (!state.liveTurn) return state; // stray event after a session switch — ignore
      const events = [...state.liveTurn.events, action.event];
      if (action.event.type === "turn_complete") {
        const turn: ScrollbackItem = { kind: "turn", id: nextScrollbackId++, userText: state.liveTurn.userText, events };
        return { ...state, liveTurn: undefined, scrollback: [...state.scrollback, turn] };
      }
      return { ...state, liveTurn: { ...state.liveTurn, events } };
    }
    case "LOAD_SCROLLBACK": {
      const scrollback: ScrollbackItem[] = action.turns.map((t) => ({ kind: "turn", id: nextScrollbackId++, userText: t.userText, events: t.events }));
      return { ...state, scrollback, scrollbackGeneration: state.scrollbackGeneration + 1, liveTurn: undefined };
    }
    case "SHOW_WELCOME": {
      const item: ScrollbackItem = {
        kind: "welcome",
        id: nextScrollbackId++,
        baseHue: action.baseHue,
        backend: action.backend,
        model: action.model,
        authStatuses: action.authStatuses,
        recentSessions: action.recentSessions,
      };
      return { ...state, scrollback: [item, ...state.scrollback] };
    }
    case "QUEUE_MESSAGE":
      return { ...state, queuedMessages: [...state.queuedMessages, action.text] };
    case "DEQUEUE_MESSAGE":
      return { ...state, queuedMessages: state.queuedMessages.slice(1) };
    case "CLEAR_SCROLLBACK":
      return { ...state, scrollback: [], scrollbackGeneration: state.scrollbackGeneration + 1 };
    case "SYSTEM_MESSAGE":
      return { ...state, scrollback: [...state.scrollback, { kind: "system", id: nextScrollbackId++, text: action.text, tone: action.tone ?? "info" }] };
  }
}

type Overlay =
  | { kind: "none" }
  | { kind: "select"; title: string; items: SelectItem<string>[]; resolve: (value: string | undefined) => void }
  | { kind: "prompt"; message: string; resolve: (value: string | undefined) => void }
  | { kind: "provider-model"; providers: ProviderModels[]; currentBackend?: BackendId; resolve: (value: { backend: BackendId; model: string } | undefined) => void }
  | { kind: "ask"; question: string; options: SelectItem<string>[]; allowMultiple: boolean; resolve: (value: string[]) => void };

function toneColor(tone: "info" | "error" | "success"): string | undefined {
  if (tone === "error") return theme.error;
  if (tone === "success") return theme.success;
  return theme.muted;
}

const HELP_TEXT = [
  ...COMMANDS.map((c) => `${c.usage.padEnd(46)} ${c.description}`),
  "(typing a message while one is already running queues it — sent automatically once the current turn finishes)",
].join("\n");

/** `/init`'s payload — routed through the exact same path as a normal
 * typed message (session creation, backend picking, mid-turn queueing,
 * all apply identically), it just supplies the prompt for you. Once
 * AGENTS.md exists, every adapter automatically loads it into future
 * turns in this directory (see `loadProjectContext`). */
const INIT_PROMPT =
  "Look around this repository and write (or update) an AGENTS.md file at its root for future coding-agent sessions here: " +
  "what the project is and how it's structured, the actual build/test/lint commands (verify them, don't guess), key " +
  "directories and conventions, and any non-obvious gotchas you noticed. Keep it concise — skip anything already obvious " +
  "from file/directory names. Explore with your file tools first, then write the file.";

export function ChatApp(): React.JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [config, setConfig] = useState<PkwnConfig | undefined>();
  const [ready, setReady] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Drains one queued message at a time once the previous turn's
   * `liveTurn` clears — mirrors the immediate-send path in `sendLine`
   * exactly, just triggered by the turn finishing instead of by the
   * user hitting Enter. */
  useEffect(() => {
    if (state.liveTurn) return;
    const next = state.queuedMessages[0];
    if (next === undefined) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    dispatch({ type: "DEQUEUE_MESSAGE" });
    dispatch({ type: "START_TURN", userText: next });
    wsRef.current.send(JSON.stringify({ text: next }));
  }, [state.liveTurn, state.queuedMessages]);

  // Live "/..." suggestions: only while still typing the command name
  // itself (no space yet) — once args start, it's none of our business.
  const commandPrefix = inputValue.startsWith("/") && !inputValue.slice(1).includes(" ") ? inputValue.slice(1) : undefined;
  const commandMatches = commandPrefix !== undefined ? matchCommands(commandPrefix) : [];

  // Re-anchor the highlight to the top whenever the filtered list itself
  // changes (another keystroke narrows/widens it) — keeps ↑/↓ from
  // pointing at a match that's no longer there, or no longer the one
  // the dropdown visually shows as first.
  useEffect(() => {
    setHighlightedSuggestion(0);
  }, [commandPrefix]);

  /** Esc aborts the active session's in-flight turn — the same request
   * `/stop` sends, just one keypress instead of typing a command. Only
   * fires when nothing else owns Esc: every overlay (select/prompt/
   * provider-model/ask) already handles its own Esc to dismiss itself,
   * and this checks `overlay.kind === "none"` so it never fires
   * alongside that and aborts the turn the user was just answering a
   * question about. */
  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    if (key.escape && overlay.kind === "none" && config) {
      const s = stateRef.current;
      if (s.liveTurn && s.activeId) void stopSession(config, s.activeId);
    }
  });

  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    void (async () => {
      try {
        const cfg = await loadConfig();
        await ensureDaemonRunning(cfg);
        setConfig(cfg);
        const [lastUsed, authStatus, sessionList] = await Promise.all([
          readLastUsed(cfg.pkwnHome, process.cwd()),
          apiRequest<AuthStatusResponse>(cfg, "GET", "/v1/auth/status").catch(() => ({ backends: [] })),
          apiRequest<SessionListResponse>(cfg, "GET", "/v1/sessions").catch(() => ({ sessions: [] })),
        ]);
        dispatch({
          type: "SHOW_WELCOME",
          baseHue: Math.floor(Math.random() * 360),
          backend: lastUsed?.backend,
          model: lastUsed?.model,
          authStatuses: authStatus.backends,
          recentSessions: sessionList.sessions,
        });
        if (lastUsed) {
          dispatch({ type: "SET_PENDING", backend: lastUsed.backend, model: lastUsed.model, permission: lastUsed.permission ?? "edit", cwd: process.cwd() });
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: `ready: ${lastUsed.backend}${lastUsed.model ? `:${lastUsed.model}` : ""} @ ${basename(process.cwd())} (last used here) — type a message to start a new session, or /resume to reattach an existing one. /help for commands, Ctrl-D to exit.`,
          });
        } else {
          dispatch({ type: "SYSTEM_MESSAGE", text: "connected. /connect [claude|codex|gemini] to start (pick interactively if omitted), /help for commands, Ctrl-D to exit." });
        }
        setReady(true);
      } catch (err) {
        dispatch({ type: "SYSTEM_MESSAGE", text: String(err instanceof Error ? err.message : err), tone: "error" });
        setTimeout(() => exit(), 500);
      }
    })();
  }

  const showSelect = (title: string, items: SelectItem<string>[]): Promise<string | undefined> => {
    if (items.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => setOverlay({ kind: "select", title, items, resolve }));
  };
  const showPrompt = (message: string): Promise<string | undefined> => {
    return new Promise((resolve) => setOverlay({ kind: "prompt", message, resolve }));
  };
  const showProviderModel = (providers: ProviderModels[], currentBackend: BackendId | undefined): Promise<{ backend: BackendId; model: string } | undefined> => {
    return new Promise((resolve) => setOverlay({ kind: "provider-model", providers, currentBackend, resolve }));
  };
  const showAsk = (question: string, options: SelectItem<string>[], allowMultiple: boolean): Promise<string[]> => {
    return new Promise((resolve) => setOverlay({ kind: "ask", question, options, allowMultiple, resolve }));
  };
  const closeOverlay = (): void => setOverlay({ kind: "none" });

  /** Detects the model's `ask_user_question` tool call among the plain
   * event stream, pops the interactive picker, and ships the answer back
   * over the same socket, correlated by tool-call id — the daemon's
   * pending `executeTool` call for that id is what's actually awaiting
   * this reply. A malformed payload (schema mismatch) is left alone: the
   * daemon-side tool handler already returns its own error result for
   * that, no separate handling needed here. */
  const handleAskToolCall = async (askId: string, rawInput: unknown, socket: WebSocket): Promise<void> => {
    const input = rawInput as { question?: string; options?: Array<{ label?: string; description?: string }>; allowMultiple?: boolean } | undefined;
    const options = (input?.options ?? []).filter((o): o is { label: string; description?: string } => typeof o?.label === "string" && o.label.length > 0);
    if (!input?.question || options.length === 0) return;
    const items: SelectItem<string>[] = options.map((o) => ({ label: o.label, value: o.label, description: o.description }));
    const answer = await showAsk(input.question, items, input.allowMultiple === true);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ askId, answer }));
  };

  /** Closes any previous socket, opens one for `id`, and resolves once it's
   * actually open — a just-created socket is CONNECTING and `.send()`
   * throws rather than queuing (unlike a browser WebSocket). */
  const connectWs = (cfg: PkwnConfig, id: string): Promise<void> => {
    wsRef.current?.removeAllListeners();
    wsRef.current?.close();
    const url = new URL(`ws://${cfg.bindHost}:${cfg.port}/v1/sessions/${id}/attach`);
    if (cfg.apiKey) url.searchParams.set("token", cfg.apiKey);
    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.on("message", (raw) => {
      let event: AgentEvent;
      try {
        event = JSON.parse(raw.toString()) as AgentEvent;
      } catch {
        return; // ignore malformed frames rather than crashing the TUI
      }
      dispatch({ type: "AGENT_EVENT", event });
      if (event.type === "tool_call" && event.name === "ask_user_question") {
        void handleAskToolCall(event.id, event.input, socket);
      }
    });
    socket.on("error", (err) => dispatch({ type: "SYSTEM_MESSAGE", text: `connection error: ${String(err)}`, tone: "error" }));
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.once("open", () => resolve());
    socket.once("error", reject);
    return promise;
  };

  const setActiveAndConnect = async (cfg: PkwnConfig, meta: SessionMetaResponse | undefined): Promise<void> => {
    dispatch({ type: "SET_ACTIVE", meta });
    if (meta) {
      await connectWs(cfg, meta.id);
    } else {
      wsRef.current?.removeAllListeners();
      wsRef.current?.close();
      wsRef.current = undefined;
    }
  };

  const pickBackend = async (cfg: PkwnConfig): Promise<BackendId | undefined> => {
    const { backends } = await apiRequest<AuthStatusResponse>(cfg, "GET", "/v1/auth/status");
    const items = BACKEND_ORDER.map((id) => ({
      label: `${id.padEnd(7)} ${backends.find((b) => b.backend === id)?.loggedIn ? "logged in" : "not logged in"}`,
      value: id,
    }));
    const picked = await showSelect("choose a backend (↑/↓, Enter to select, Esc to cancel):", items);
    return picked && isBackendId(picked) ? picked : undefined;
  };

  const ensureBackendReady = async (cfg: PkwnConfig, backend: BackendId): Promise<boolean> => {
    const { backends } = await apiRequest<AuthStatusResponse>(cfg, "GET", "/v1/auth/status");
    if (backends.find((b) => b.backend === backend)?.loggedIn) return true;

    dispatch({ type: "SYSTEM_MESSAGE", text: `${backend} is not logged in yet.` });
    const answer = (await showPrompt(`log in to ${backend} now? [Y/n]`))?.trim().toLowerCase();
    if (answer === undefined || answer === "n" || answer === "no") return false;

    const status = await loginBackend(backend, undefined, async (q) => (await showPrompt(q)) ?? "");
    if (!status.loggedIn) {
      dispatch({ type: "SYSTEM_MESSAGE", text: `still not logged in to ${backend}${status.detail ? `: ${status.detail}` : ""} — aborting connect`, tone: "error" });
    }
    return status.loggedIn;
  };

  const requireActive = (): string | undefined => {
    const s = stateRef.current;
    if (s.activeId) return s.activeId;
    dispatch({
      type: "SYSTEM_MESSAGE",
      text: s.pendingBackend
        ? "no session yet — type a message first to start it, or /connect to change backend"
        : "no active session — type a message to pick a backend and start, or /connect first",
    });
    return undefined;
  };

  const stopSession = async (cfg: PkwnConfig, id: string): Promise<void> => {
    try {
      await apiRequest(cfg, "POST", `/v1/sessions/${id}/stop`);
      dispatch({ type: "SYSTEM_MESSAGE", text: "stop requested" });
    } catch (err) {
      dispatch({ type: "SYSTEM_MESSAGE", text: `! ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
    }
  };

  const handleCommand = async (line: string, cfg: PkwnConfig): Promise<void> => {
    const [cmd, ...args] = line.slice(1).split(/\s+/);
    const s = stateRef.current;
    try {
      switch (cmd) {
        case "connect": {
          let backend: BackendId | undefined;
          if (args[0]) {
            if (!isBackendId(args[0])) {
              dispatch({ type: "SYSTEM_MESSAGE", text: `unknown backend "${args[0]}" — expected claude | codex | gemini` });
              break;
            }
            backend = args[0];
          } else {
            backend = await pickBackend(cfg);
            if (!backend) break;
          }
          if (!(await ensureBackendReady(cfg, backend))) break;
          const cwd = args[1] ?? process.cwd();
          const model = args[2];
          dispatch({ type: "SET_PENDING", backend, model, permission: "edit", cwd });
          await writeLastUsed(cfg.pkwnHome, cwd, { backend, model, permission: "edit" });
          dispatch({ type: "SYSTEM_MESSAGE", text: `ready — ${backend}${model ? `:${model}` : ""} @ ${cwd} — type a message to start (or /model, /permission to adjust first)` });
          break;
        }
        case "model": {
          const currentBackend = s.activeBackend ?? s.pendingBackend;

          // Fast path unchanged: `/model <id>` sets a model directly on
          // whichever backend is already active/pending — no picker.
          if (args[0]) {
            if (!currentBackend) {
              requireActive();
              break;
            }
            if (s.activeId) {
              const meta = await apiRequest<SessionMetaResponse>(cfg, "PATCH", `/v1/sessions/${s.activeId}`, { model: args[0] });
              dispatch({ type: "PATCH_ACTIVE_META", model: meta.model });
            } else {
              dispatch({ type: "PATCH_PENDING", model: args[0] });
              await writeLastUsed(cfg.pkwnHome, s.pendingCwd!, { backend: currentBackend, model: args[0], permission: s.pendingPermission });
            }
            dispatch({ type: "SYSTEM_MESSAGE", text: `model set to ${args[0]}` });
            break;
          }

          if (currentBackend) {
            dispatch({ type: "SYSTEM_MESSAGE", text: `current: ${currentBackend}:${(s.activeId ? s.activeModel : s.pendingModel) ?? "(backend default)"}` });
          }

          // Only already-connected providers are offered here — `/model`
          // is for switching between backends you can already use, not
          // for starting a new login (that's `/connect`'s job). Model
          // lists for every connected provider are prefetched in parallel
          // up front so navigating between them on the left is instant —
          // no per-keystroke network round trip.
          const { backends: authList } = await apiRequest<AuthStatusResponse>(cfg, "GET", "/v1/auth/status");
          const connected = BACKEND_ORDER.filter((id) => authList.find((b) => b.backend === id)?.loggedIn);
          if (connected.length === 0) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "no connected providers yet — /connect and log in to one first" });
            break;
          }
          const providers: ProviderModels[] = await Promise.all(
            connected.map(async (id) => {
              try {
                const { models } = await apiRequest<ModelsResponse>(cfg, "GET", `/v1/backends/${id}/models`);
                return { id, models };
              } catch {
                return { id, models: [] };
              }
            }),
          );
          const picked = await showProviderModel(providers, currentBackend);
          if (!picked) break;
          const backend = picked.backend;
          let modelId: string;
          if (picked.model) {
            modelId = picked.model;
          } else {
            const custom = (await showPrompt("model id:"))?.trim();
            if (!custom) break;
            modelId = custom;
          }

          // Step 3: apply — patch in place if this is the same backend as
          // the current active session; otherwise it's a backend switch,
          // same semantics as `/connect`: pending only, detaching any
          // active session (the switch takes effect on the next message).
          if (backend === currentBackend && s.activeId) {
            const meta = await apiRequest<SessionMetaResponse>(cfg, "PATCH", `/v1/sessions/${s.activeId}`, { model: modelId });
            dispatch({ type: "PATCH_ACTIVE_META", model: meta.model });
            dispatch({ type: "SYSTEM_MESSAGE", text: `model set to ${meta.model}` });
          } else if (backend === currentBackend) {
            dispatch({ type: "PATCH_PENDING", model: modelId });
            await writeLastUsed(cfg.pkwnHome, s.pendingCwd ?? process.cwd(), { backend, model: modelId, permission: s.pendingPermission });
            dispatch({ type: "SYSTEM_MESSAGE", text: `model set to ${modelId}` });
          } else {
            const cwd = s.activeCwd ?? s.pendingCwd ?? process.cwd();
            const permission = s.activePermission ?? s.pendingPermission ?? "edit";
            dispatch({ type: "SET_PENDING", backend, model: modelId, permission, cwd });
            await writeLastUsed(cfg.pkwnHome, cwd, { backend, model: modelId, permission });
            dispatch({ type: "SYSTEM_MESSAGE", text: `switched to ${backend}:${modelId} @ ${cwd} — type a message to start (or /permission to adjust first)` });
          }
          break;
        }
        case "permission": {
          if (!s.activeId && !s.pendingBackend) {
            requireActive();
            break;
          }
          if (!args[0]) {
            if (s.activeId) {
              const meta = await apiRequest<SessionMetaResponse>(cfg, "GET", `/v1/sessions/${s.activeId}`);
              dispatch({ type: "SYSTEM_MESSAGE", text: `current permission: ${meta.permission}` });
            } else {
              dispatch({ type: "SYSTEM_MESSAGE", text: `current permission: ${s.pendingPermission}` });
            }
            break;
          }
          if (args[0] !== "safe" && args[0] !== "edit" && args[0] !== "full") {
            dispatch({ type: "SYSTEM_MESSAGE", text: "usage: /permission <safe|edit|full>" });
            break;
          }
          if (s.activeId) {
            const meta = await apiRequest<SessionMetaResponse>(cfg, "PATCH", `/v1/sessions/${s.activeId}`, { permission: args[0] });
            dispatch({ type: "PATCH_ACTIVE_META", permission: meta.permission });
            dispatch({ type: "SYSTEM_MESSAGE", text: `permission set to ${meta.permission}` });
          } else {
            dispatch({ type: "PATCH_PENDING", permission: args[0] });
            await writeLastUsed(cfg.pkwnHome, s.pendingCwd!, { backend: s.pendingBackend!, model: s.pendingModel, permission: args[0] });
            dispatch({ type: "SYSTEM_MESSAGE", text: `permission set to ${args[0]}` });
          }
          break;
        }
        case "init": {
          await sendLine(INIT_PROMPT, cfg);
          break;
        }
        case "new": {
          const id = requireActive();
          if (!id) break;
          const current = await apiRequest<SessionMetaResponse>(cfg, "GET", `/v1/sessions/${id}`);
          const meta = await apiRequest<SessionMetaResponse>(cfg, "POST", "/v1/sessions", {
            backend: current.backend,
            cwd: current.cwd,
            model: current.model,
            permission: current.permission,
          });
          await setActiveAndConnect(cfg, meta);
          // Clears the visible screen (not the OS scrollback — same
          // TTY-only no-op as the startup clear in tui/index.tsx) and
          // drops the old conversation's `<Static>` history, so `/new`
          // actually reads as a clean slate instead of just tacking a
          // new session onto the bottom of the old one's transcript.
          console.clear();
          dispatch({ type: "CLEAR_SCROLLBACK" });
          dispatch({ type: "SYSTEM_MESSAGE", text: `started a fresh conversation — session ${meta.id}` });
          break;
        }
        case "clear": {
          const { sessions: list } = await apiRequest<SessionListResponse>(cfg, "GET", "/v1/sessions");
          if (list.length === 0) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "no sessions to clear" });
            break;
          }
          const answer = (await showPrompt(`delete all ${list.length} session(s)? this cannot be undone. [y/N]`))?.trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            dispatch({ type: "SYSTEM_MESSAGE", text: "cancelled" });
            break;
          }
          let deleted = 0;
          let skipped = 0;
          for (const x of list) {
            try {
              await apiRequest(cfg, "DELETE", `/v1/sessions/${x.id}`);
              deleted++;
            } catch {
              // Still running (server refuses to delete an in-flight
              // session) — leave it be rather than failing the whole batch.
              skipped++;
            }
          }
          await setActiveAndConnect(cfg, undefined);
          console.clear();
          dispatch({ type: "CLEAR_SCROLLBACK" });
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: `cleared ${deleted} session${deleted === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} skipped — still running; /stop them first)` : ""}`,
          });
          break;
        }
        case "resume": {
          let id = args[0];
          if (!id) {
            const { sessions: list } = await apiRequest<SessionListResponse>(cfg, "GET", "/v1/sessions");
            const cwd = process.cwd();
            const inFolder = list.filter((x) => x.cwd === cwd);
            const candidates = (inFolder.length > 0 ? inFolder : list).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            if (candidates.length === 0) {
              dispatch({ type: "SYSTEM_MESSAGE", text: "no existing sessions to resume — type a message to start one, or /connect first" });
              break;
            }
            const title =
              inFolder.length === 0
                ? `no sessions in ${cwd} — showing all (↑/↓, Enter to select, Esc to cancel):`
                : "choose a session to resume (↑/↓, Enter to select, Esc to cancel):";
            const items = candidates.map((x) => ({
              label: `${x.id}  ${x.backend.padEnd(7)} ${(x.model ?? "default").padEnd(12)} ${x.status.padEnd(11)} ${x.cwd}`,
              value: x.id,
            }));
            const picked = await showSelect(title, items);
            if (!picked) break;
            id = picked;
          }
          const meta = await apiRequest<SessionMetaResponse>(cfg, "GET", `/v1/sessions/${id}?tail=500`);
          await setActiveAndConnect(cfg, meta);
          // Same clean-slate treatment as /new: clear the visible screen
          // and force a fresh `<Static>` mount (see `scrollbackGeneration`)
          // before replaying this session's history.
          console.clear();
          dispatch({ type: "CLEAR_SCROLLBACK" });
          if (meta.transcriptTail && meta.transcriptTail.length > 0) {
            dispatch({ type: "LOAD_SCROLLBACK", turns: transcriptToTurns(meta.transcriptTail) });
          }
          dispatch({ type: "SYSTEM_MESSAGE", text: `resumed session ${meta.id} (${meta.backend}:${meta.model ?? "default"} @ ${meta.cwd})` });
          break;
        }
        case "sessions": {
          const { sessions: list } = await apiRequest<SessionListResponse>(cfg, "GET", "/v1/sessions");
          if (list.length === 0) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "(no sessions)" });
            break;
          }
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: list
              .map((x) => `${x.id === s.activeId ? "*" : " "} ${x.id}  ${x.backend.padEnd(7)} ${x.status.padEnd(11)} ${x.cwd}${x.title ? `  — ${x.title}` : ""}`)
              .join("\n"),
          });
          break;
        }
        case "search": {
          const query = args.join(" ");
          if (!query) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "usage: /search <text>" });
            break;
          }
          const { results } = await apiRequest<SearchResponse>(cfg, "GET", `/v1/sessions/search?q=${encodeURIComponent(query)}`);
          if (results.length === 0) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "(no matches)" });
            break;
          }
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: results.map((r) => `${r.sessionId === s.activeId ? "*" : " "} ${r.sessionId}  ${r.direction.padEnd(3)} ${r.ts}  ${r.snippet}`).join("\n"),
          });
          break;
        }
        case "stop": {
          const id = requireActive();
          if (!id) break;
          await stopSession(cfg, id);
          break;
        }
        case "rm": {
          const target = args[0] ?? s.activeId;
          if (!target) {
            dispatch({ type: "SYSTEM_MESSAGE", text: "usage: /rm [session-id]" });
            break;
          }
          await apiRequest(cfg, "DELETE", `/v1/sessions/${target}`);
          if (target === s.activeId) await setActiveAndConnect(cfg, undefined);
          dispatch({ type: "SYSTEM_MESSAGE", text: `deleted ${target}` });
          break;
        }
        case "help":
          dispatch({ type: "SYSTEM_MESSAGE", text: HELP_TEXT });
          break;
        case "exit":
        case "quit":
          exit();
          return;
        default: {
          const guess = suggestCommand(cmd ?? "");
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: guess ? `unknown command /${cmd} — did you mean /${guess}? (/help for the full list)` : `unknown command /${cmd} — /help for the full list`,
          });
        }
      }
    } catch (err) {
      dispatch({ type: "SYSTEM_MESSAGE", text: `! ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
    }
  };

  /** A plain (non-`/`) line is a chat message. If nothing's active or
   * pending, typing is itself the trigger to pick a backend and start —
   * direct prompting always works, it never dead-ends on "no active
   * session." This is also the one place a session actually gets
   * POSTed, so idly running `/connect` without ever typing anything
   * never litters `/sessions`. */
  const sendLine = async (line: string, cfg: PkwnConfig): Promise<void> => {
    const s = stateRef.current;
    if (wsRef.current && s.activeId && wsRef.current.readyState === WebSocket.OPEN) {
      if (s.liveTurn) {
        // Don't clobber the in-flight turn's display — the daemon
        // already serializes turns on a session regardless of when the
        // client sends them, so just hold this one and fire it once
        // `liveTurn` clears (see the drain effect above).
        dispatch({ type: "QUEUE_MESSAGE", text: line });
        dispatch({ type: "SYSTEM_MESSAGE", text: `queued (${s.queuedMessages.length + 1} pending) — will send once the current turn finishes` });
        return;
      }
      dispatch({ type: "START_TURN", userText: line });
      wsRef.current.send(JSON.stringify({ text: line }));
      return;
    }
    try {
      let backend = s.pendingBackend;
      if (!backend) {
        backend = await pickBackend(cfg);
        if (!backend) return;
      }
      if (!(await ensureBackendReady(cfg, backend))) return;
      const cwd = s.pendingCwd ?? process.cwd();
      const model = s.pendingModel;
      const permission = s.pendingPermission ?? "edit";
      const meta = await apiRequest<SessionMetaResponse>(cfg, "POST", "/v1/sessions", { backend, cwd, model, permission });
      await setActiveAndConnect(cfg, meta);
      dispatch({ type: "SYSTEM_MESSAGE", text: `started session ${meta.id} (${meta.backend} @ ${meta.cwd})` });
      dispatch({ type: "START_TURN", userText: line });
      wsRef.current!.send(JSON.stringify({ text: line }));
      await writeLastUsed(cfg.pkwnHome, cwd, { backend, model, permission });
    } catch (err) {
      dispatch({ type: "SYSTEM_MESSAGE", text: `! ${err instanceof Error ? err.message : String(err)}`, tone: "error" });
    }
  };

  const handleSubmit = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    setInputValue("");
    if (!trimmed || !config) return;
    setInputHistory((h) => [...h, trimmed]);
    if (trimmed.startsWith("/")) await handleCommand(trimmed, config);
    else await sendLine(trimmed, config);
  };

  const promptBackend = state.activeBackend ?? state.pendingBackend;
  const promptModel = state.activeBackend ? state.activeModel : state.pendingModel;
  const promptCwd = state.activeBackend ? state.activeCwd : state.pendingCwd;
  const promptPermission = state.activeBackend ? state.activePermission : state.pendingPermission;
  const promptFolder = promptCwd ? basename(promptCwd) || promptCwd : basename(process.cwd());
  const promptText = promptBackend ? `pkwn(${promptBackend}:${promptModel ?? "default"} @ ${promptFolder})> ` : "pkwn> ";

  // Clamped defensively: `commandMatches` and `highlightedSuggestion` are
  // independent state, so a match list that shrank on the exact same
  // render the highlight hasn't caught up to yet must never index past
  // its end.
  const clampedHighlightedIndex = Math.min(highlightedSuggestion, commandMatches.length - 1);
  const highlightedMatch = commandMatches[clampedHighlightedIndex];
  const tabSuggestion = highlightedMatch && highlightedMatch.name !== commandPrefix?.toLowerCase() ? `/${highlightedMatch.name} ` : undefined;

  return (
    <Box flexDirection="column">
      <Static key={state.scrollbackGeneration} items={state.scrollback}>
        {(item) =>
          item.kind === "turn" ? (
            <TurnView key={item.id} userText={item.userText} events={item.events} />
          ) : item.kind === "welcome" ? (
            <WelcomeBanner key={item.id} baseHue={item.baseHue} backend={item.backend} model={item.model} authStatuses={item.authStatuses} recentSessions={item.recentSessions} />
          ) : (
            <Text key={item.id} color={toneColor(item.tone)}>
              {item.text}
            </Text>
          )
        }
      </Static>
      {state.liveTurn ? <LiveTurn userText={state.liveTurn.userText} events={state.liveTurn.events} /> : null}
      {state.queuedMessages.map((msg, i) => (
        <Text key={i} color={theme.muted}>
          ⏳ queued: {msg}
        </Text>
      ))}
      <StatusBar backend={promptBackend} model={promptModel} permission={promptPermission} folder={promptFolder} isActive={!!state.activeId} />
      {overlay.kind === "select" ? (
        <SelectList
          title={overlay.title}
          items={overlay.items}
          onSelect={(value) => {
            overlay.resolve(value);
            closeOverlay();
          }}
          onCancel={() => {
            overlay.resolve(undefined);
            closeOverlay();
          }}
        />
      ) : null}
      {overlay.kind === "prompt" ? (
        <PromptOverlay
          message={overlay.message}
          onSubmit={(value) => {
            overlay.resolve(value);
            closeOverlay();
          }}
        />
      ) : null}
      {overlay.kind === "provider-model" ? (
        <ProviderModelPicker
          providers={overlay.providers}
          currentBackend={overlay.currentBackend}
          onSelect={(value) => {
            overlay.resolve(value);
            closeOverlay();
          }}
          onCancel={() => {
            overlay.resolve(undefined);
            closeOverlay();
          }}
        />
      ) : null}
      {overlay.kind === "ask" ? (
        <AskOverlay
          question={overlay.question}
          options={overlay.options}
          allowMultiple={overlay.allowMultiple}
          onSubmit={(value) => {
            overlay.resolve(value);
            closeOverlay();
          }}
        />
      ) : null}
      {ready && overlay.kind === "none" ? <CommandSuggestions matches={commandMatches} highlightedIndex={clampedHighlightedIndex} /> : null}
      {ready ? (
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          history={inputHistory}
          prompt={promptText}
          isActive={overlay.kind === "none"}
          suggestion={tabSuggestion}
          suggestionNav={
            commandMatches.length > 0
              ? {
                  count: commandMatches.length,
                  onMove: (delta) => setHighlightedSuggestion((i) => (i + delta + commandMatches.length) % commandMatches.length),
                  onAccept: () => {
                    const chosen = commandMatches[clampedHighlightedIndex];
                    if (chosen) void handleSubmit(`/${chosen.name}`);
                  },
                }
              : undefined
          }
        />
      ) : null}
    </Box>
  );
}
