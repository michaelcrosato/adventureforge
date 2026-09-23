/**
 * Quest catalog for the UI.
 *
 * Vite bundles every shipped quest pack as raw YAML text at build time, so the
 * browser never touches the filesystem. Each entry carries the source text the
 * GameSession compiles on demand. The New York overworld (`worldData.js`) is the
 * single world AND quest registry; `App.tsx` maps an overworld quest's source
 * path to the matching pack entry here and compiles it in-browser.
 *
 * This module deliberately does NO YAML parsing. It is evaluated during import,
 * before React mounts and before the page paints anything, and the double-click
 * launcher opens a single self-contained file with no loading state — so every
 * millisecond spent here is a millisecond of blank screen. It used to run a full
 * `yaml.parse` over all twelve shipped packs (~680 KB) to fill a `name` field
 * whose only consumer was the sort on the next line: `App.tsx` looks entries up
 * by `path` and reads `source`, and `GameSession.start*` re-parses the one
 * selected pack anyway. Sorting by `path` is the same stable, deterministic
 * order without the parse. Anything that needs an authored title should read
 * `meta.title` off the compiled pack (`GameSession.title`), not re-parse here.
 */

type PackEntry = {
  path: string;
  source: string;
};

// Shipped RPG quest packs, as raw strings.
const raw = import.meta.glob("../../content/rpg/quests/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const PACKS: PackEntry[] = Object.entries(raw)
  .map(([path, source]) => ({ path, source }))
  .sort((a, b) => a.path.localeCompare(b.path));
