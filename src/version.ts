// Reads the version straight from package.json rather than hardcoding it
// a second place to keep in sync on every release. The relative path is
// identical before and after compilation: `src/version.ts` and the
// compiled `dist/version.js` both sit one level below the project root,
// so `../package.json` resolves correctly from either location.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };

export const PKWN_VERSION: string = pkg.version;
