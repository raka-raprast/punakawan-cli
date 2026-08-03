import { useEffect, useState } from "react";
import { Text } from "ink";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../theme.js";
import { hueToHex } from "../colors.js";

// Degrees the rainbow advances per tick. 360/SPINNER_FRAMES.length would
// complete exactly one full hue cycle per spin of the glyph; a bit faster
// than that (~1.7x) so the color visibly races ahead of the shape instead
// of just recoloring the same frame twice per lap.
const HUE_STEP_DEG = 24;

/** Only ever mounted inside `LiveTurn` — genuinely transient (removed the
 * moment `turn_complete` fires), so animating it here is safe, unlike
 * `WelcomeBanner`'s now-fixed mistake of animating something that ends up
 * frozen into `<Static>` scrollback. */
export function Spinner(props: { label?: string; color?: string }): React.JSX.Element {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color={props.color ?? hueToHex(tick * HUE_STEP_DEG)} bold>
      {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}
      {props.label ? ` ${props.label}` : ""}
    </Text>
  );
}
