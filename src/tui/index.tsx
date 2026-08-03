// Entry point cli.ts calls for `pkwn` / `pkwn chat` — mounts the Ink app.
//
// Deliberately NOT the alternate screen buffer: that buffer has no
// scrollback of its own, and most terminals (iTerm2, Terminal.app, ...)
// translate mouse-wheel/trackpad scroll into synthetic Up/Down key
// presses while it's active — which this app already binds to prompt
// history recall (see TextInput), so "scrolling" the conversation just
// cycled through previously sent messages instead. Rendering into the
// normal buffer restores real OS-level scrollback at the cost of the
// vim/htop-style "conversation vanishes on exit" behavior — an
// intentional trade, chat history staying visible in your terminal
// after quitting is the more useful default here anyway.
import { render } from "ink";
import { ChatApp } from "./App.js";

export async function runChatTui(): Promise<void> {
  // Clears the visible screen (not the OS scrollback buffer — a TTY-only
  // no-op otherwise) so pkwn opens on a blank screen instead of stacking
  // under whatever was already in the terminal, without reintroducing
  // the alternate-screen buffer this file deliberately avoids above.
  console.clear();
  // Ink's own default (30fps) is fine for most apps, but streaming text
  // deltas arrive in irregular bursts and stack with the spinner's own
  // tick — capping lower gives Ink's internal throttle more room to
  // coalesce a burst into one repaint instead of several back-to-back
  // ones, which is what shows up as flicker during active generation.
  const { waitUntilExit } = render(<ChatApp />, { exitOnCtrlC: true, maxFps: 20 });
  await waitUntilExit();
}
