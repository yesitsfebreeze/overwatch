# Hotmap (Obsidian plugin)

The Mosaic call-graph heat map inside the vault: the hotness cube as a tab, its lists as a native
right-sidebar panel, and the same map as Dataview-queryable notes. Desktop only (it reads the
checkout next to the vault through node, and the cube needs WebGPU).

The folder is self-contained: the engine (`graph-core.js`, `map-merge.js`, `similar.js`,
`cube.js`, `codenotes.js`) sits beside `main.js`, and overwatch ships the folder in its vault
scaffold (`data/vault/.obsidian/plugins/hotmap`). It finds the checkout as the folder holding
`.overwatch/vault` and reads the compiler's maps from `<repo>/.mosaic/map/src-*`; without them
the views say so. The scaffold copy never overwrites an existing file, so a vault that already has
the plugin gets updates by copying the folder.

## Where it shows up

- **Ribbon icon** (left ribbon, next to graph view) — opens the cube and the panel.
- **`Hotness cube` tab** — the WebGPU cube alone: program picker, Reload, canvas.
- **`Hotmap` right-sidebar panel** — counts, a search bar, a best-first / worst-first toggle (best
  first is the larger value of every key: hottest, most callers, most tests), a similarity filter
  (any / ≈70–90% / identical: only procedures with a near-clone body, each group listed together,
  the row tooltip names the twin), three sort keys (x, y, z: x primary, y and z tiebreaks) and the
  procedure list. The sort keys are the
  cube's axes: box size follows list rank — the top entry owns the biggest box and each next one a
  1/rank share of it, so the cube is top-heavy and scales down naturally — and each axis follows one
  sort key. Reversing the order reverses the cube. Pick a row to centre the cube; pick in the cube to
  highlight the row; the search narrows the cube itself.
- **Command palette:** `Hotmap: Open hotness cube`, `Hotmap: Write map notes (Dataview)`,
  `Hotmap: Write code notes (code/)` (the whole codebase as linked notes under `code/`; see
  `dev/tools/hotmap/README.md`).
- **Settings → Community plugins → Hotmap → Options** — procedure-note count and notes folder.

The plugin shows one map over the codebase: every `src-*` build (`src-compiler`,
`src-compiler-cmd`) is merged by `server.js` into the synthetic program `codebase`, one node per
declaration with calls unioned. Test and example maps (`dev-tests-*`, `dev-examples-*`) stay on
disk for `query.mjs` but stay out of the viewer.

## The cube

The cube page is served, not inlined. `server.js` serves over loopback from the checkout the vault
sits in (found by walking up from the vault directory):

- `view.html` (this plugin), `/graph-core.js`, `/cube.js` from `dev/tools/hotmap/`
- `/codebase/index.json` — every `src-*` map merged into one document

The page runs in an iframe so it keeps its own document and a real origin (`127.0.0.1` counts as
a secure context, so `navigator.gpu` is available). It is the same page
loopback server in this plugin serves it, so there is one viewer, not two.

The server injects into the HTML response:

- **theme** — the app's `--background-primary`, `--text-normal`, `--interactive-accent`, etc.
  (`theme()` in `main.js` → `themeCss` in `server.js`), so the cube follows the vault's light/dark
  theme and accent, with a fallback to the body's painted colours.
- **`?part=cube`** — hides the page's own sidebar (`aside`) so the tab is canvas only, and adds a
  small bridge: cube picks go to the panel as `postMessage`, panel picks come back as `select`.
  The bridge hooks the page's `GraphCore` and `HotCube` globals instead of editing the file.
- **cube.js clear colour** — Obsidian composites the WebGPU canvas opaque, so the page background
  never shows through the canvas. The server rewrites the render pass clear value in the served
  `cube.js` to the theme background; the file on disk keeps its transparent clear.

The map is written by the compiler: every successful `mosaic build`, `run` or `test` writes
`.mosaic/map/<program>/{index.json,MAP.md}`. Open the cube after a build.

## Notes written for Dataview

`Hotmap: Write map notes` walks every `src-*` map and writes, under
`01 Specs/10 Tooling and Protocols/Codebase Map/` (gitignored; delete the folder to drop them):

- `Hotmap.md` — one overview across programs: program table, hottest procedures across all of
  them, hot-but-untested.
- `<program>/Hotmap.md` — per-program dashboard: packages by cross-package calls, hottest
  procedures, hot-but-untested.
- `<program>/packages/<package>.md` — `type: hotmap-package`: `procedures`, `in_calls`,
  `out_calls`, `dependents`, `rank`, `untested`, hottest members, and the packages that call it.
- `<program>/procedures/<package>.<name>.md` — the N hottest procedures (`type:
  hotmap-procedure`): `hotness`, `pagerank`, `callers`, `callees`, `tests`, `location`,
  `signature`, `external_calls`, `effects` when present, `untested`.

Query them from any note:

````markdown
```dataview
TABLE program, package, hotness, callers, tests, location
FROM "01 Specs/10 Tooling and Protocols/Codebase Map"
WHERE type = "hotmap-procedure" AND untested = true
SORT hotness DESC
LIMIT 20
```
````

Hotness is the viewer's formula: `1 + callers + 5 × PageRank`. Only the top N procedures get
notes (settings); the cube, the panel and `query.mjs` still see all of them.

A manifest per program (`.hotmap-manifest.json`) lets the next run delete notes it no longer
generates.

## Checks

```sh
node ".overwatch/vault/.obsidian/plugins/hotmap/mapnotes.test.mjs"   # note texts and overview from a fixture
node ".overwatch/vault/.obsidian/plugins/hotmap/server.test.mjs"     # page, cube mode, theme, no path escape
```

The server check skips with exit 0 when `.mosaic/map/` is empty.

## Limits

- Desktop only; `isDesktopOnly: true`.
- Obsidian composites the WebGPU canvas opaque, so the page background never shows through it.
  The default clears the render pass to the theme background instead; the **Transparent canvas**
  setting serves the page with a transparent background and leaves the clear alpha alone, which
  only helps where the app honours canvas alpha (else the cube area is black).
- The cube needs WebGPU (current Chrome/Edge engine). Without it the page shows its own notice;
  the panel and the Dataview notes still work.
- The panel and the cube build their graphs independently (two parses of one `index.json`); the
  panel rebuilds when you change its program.
- The cube shows the merged `codebase` map; a rebuild of either program is picked up on reload.
