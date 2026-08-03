// Small color-math helpers shared by anything that wants a smooth rainbow
// sweep instead of cycling a fixed handful of chalk color names.

/** Degrees-of-hue HSL → hex (full saturation, mid lightness — vivid but
 * still readable on both light and dark terminal backgrounds). */
export function hueToHex(hueDeg: number): string {
  const h = ((hueDeg % 360) + 360) % 360;
  const c = 1;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = 0.35; // lift the floor so no channel bottoms out to black
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
