# OpenPlotCNC — Multi-Channel Backplotter

An open-source VS Code extension providing a **multi-channel G-code editor** and a
**2D backplotter** for **Fanuc** and **Mitsubishi** turning and **Swiss-type**
CNC machines. Runs on Windows, macOS and Linux.

![status](https://github.com/coastalnotes/openplotcnc/actions/workflows/ci.yml/badge.svg)

---

## Features

### The app

- **Activity-Bar panel** — OpenPlotCNC has its own icon in the sidebar. Pick a
  program, see the channels it splits into, load a machine, open the backplotter.
- **Fusion 360-style ribbon** — Home / Simulate / View / Setup / Help tabs with
  large labelled buttons. Built for machinists, not VS Code power users.
- **Backplot is manual** — the editor + alignment show immediately; the 2D
  plot builds only when you press *Run Backplot*.

### Machine templates

Load a standard machine and its tool list, then customise:

| Template | Notes |
| --- | --- |
| **Citizen Cincom L12-VII** | 12 mm Swiss, 2 tool systems, Citizen (Meldas) control, 5 live spindles, standard T11xx / T21xx / T31xx stations |
| **Citizen Cincom L12-X** | as VII plus the Y2 back axis, 7 live spindles |
| **Generic Swiss (Fanuc, 2 paths)** | neutral starting point |
| **Generic Lathe (Fanuc, 1 path)** | fixed-headstock turning centre |

Templates live in [`machines/`](machines/) as plain JSON — copy and hand-edit
them, or point `openplotcnc.machine.template` at one. Loading a template seeds
`openplotcnc.setup.json` next to your program.

### Multi-channel editor (up to 4 paths)

- **Multi-file projects** — `PATH1.NC` … `PATH4.NC` linked through the workspace.
- **Single-file multi-channel** — `$1`…`$4` (or `O1001`…) section markers, split
  in place. Sections end at `M99`, `M30` or `M02`; a `$0` common/variable block
  is kept aside; `M98 P####` / `M98 H####` subprograms are expanded into the plot.
- **Synchronized columns** — 2–4 Monaco editors side by side with scroll and
  edit locking.
- **Wait-code alignment engine** — shared rendezvous codes are pinned to the same
  visual row across every participating channel:
  - Fanuc: `M100`–`M199`, `M<code> P<mask>`, `WAITCODE n`
  - Mitsubishi: `!L1`–`!Ln`, `! n`, `M100`
  - Citizen: `!L2`, `!1L2`, `!12L2` (systems 1 & 2), `!1!2L2`, and `M600`–`M699`
    queue / waiting M-codes
- Custom G-code syntax highlighting, folding and line decorations.

### In-app help

A dialect- and machine-aware reference panel (Help tab): getting started, how
files split, wait/sync codes for *your* control, canned cycles, polar /
cylindrical interpolation, Swiss kinematics, tooling, and the machine notes for
the loaded template.

### CNC control engine

- Linear / circular motion `G00 G01 G02 G03` (I/J/K and R arcs).
- Plane select `G17 G18 G19`, units `G20 G21`, distance `G90 G91`,
  feed mode `G94 G95` / `G98 G99`.
- Work offsets `G54`–`G59`, `G54.1 Pn`.
- Cutter-radius / length comp `G40 G41 G42` · `G43 G44 G49`.
- Polar / cylindrical interpolation `G12.1 G13.1` · `G07.1`.
- Lathe canned cycles `G70 G71 G72 G73 G74 G75 G76 G90 G92` — profile ranges
  captured from `P`/`Q`.
- Sub-spindle / part-transfer tags `G30 G140 G141 G142`.
- Dwell `G04 P/X/U`.

### Swiss kinematics

- Sliding **headstock** model — `Z` feeds bar stock through a fixed **guide
  bushing**; the collet face advances as `headstockZ = mainSpindleFaceZ − Z`.
- **Main spindle** (`Z1 X1 Y1 C1`) vs **sub spindle** (`Z2 X2 C2`) frames, with
  the sub frame mirrored about the pickup plane.
- Standard-lathe mode keeps the headstock fixed.

### 2D backplot (Z–X turning plane)

- Colour-coded channels — Path 1 cyan, Path 2 amber, Path 3 magenta, Path 4 green.
- Rapids drawn dashed, feed moves solid; true arc geometry (not chords).
- Spindle centreline, guide-bushing marker, grid, fit-view.

### Time-synchronized playback

- Play / pause / step / scrub, speed **0.1×–10×**.
- All channels advance on one wall clock and **stall at wait codes** until every
  participating channel has arrived.
- Feed-rate-aware timing (per-minute, per-rev with rpm/CSS).

### Configuration

- JSON-schema-backed setup UI (`Setup…` button or
  `OpenPlotCNC: Configure Tooling & Machine Setup`).
- Persisted to `openplotcnc.setup.json` in the workspace root.
- Bar stock (OD / ID / length / bushing protrusion), tool geometry
  (turning inserts, boring bars, parting/grooving blades, live tools) and
  kinematics mode.

---

## Getting started

```bash
npm install
npm run compile        # build extension + webview bundles
npm test               # typecheck + unit tests
```

Press <kbd>F5</kbd> in VS Code to launch the **Extension Development Host** (it
opens the `samples/swiss-fanuc` folder).

1. Open `PATH1.NC`.
2. Run **OpenPlotCNC: Open Backplotter** (editor title-bar icon or command
   palette).
3. The webview loads `PATH1.NC` + `PATH2.NC` as channels 1 & 2, aligns the
   `M100` / `M105` sync codes, and renders both toolpaths.
4. Press play on the transport bar.

### Commands

| Command | ID |
| --- | --- |
| Open Backplotter | `openplotcnc.openBackplotter` |
| Sync Channels From Workspace | `openplotcnc.syncChannels` |
| Configure Tooling & Machine Setup | `openplotcnc.configureTooling` |

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `openplotcnc.machine.kinematicsMode` | `swiss-type` | or `standard-lathe` |
| `openplotcnc.machine.dialect` | `fanuc` | or `mitsubishi` |
| `openplotcnc.channels.count` | `2` | 1–4 |
| `openplotcnc.channels.fileGlobs` | `PATH1.NC` … | sibling files → channels |
| `openplotcnc.channels.singleFileHeaders` | `$1` … `$4` | in-file section markers |
| `openplotcnc.playback.defaultSpeed` | `1` | 0.1–10 |

---

## Architecture

```
src/
  parser/        zero-dependency lexer + parser (AST, modal state, sync tokens)
  kinematics/    Swiss / turning transform → world-space move segments
  channels/      wait-code alignment engine
  simulation/    multi-channel wall-clock schedule with barrier stalls
  config/        setup defaults + JSON schema / normaliser
  webview/       extension-host side of the panel (loader, IPC, write-back)
webview-ui/
  editor/        Monaco multi-channel editor + alignment view-zones
  render/        Three.js scene, toolpath builder, animator
  playback/      transport controls
  config/        setup form
```

The `src/parser`, `src/kinematics`, `src/channels`, `src/simulation` and
`src/config` folders are **pure, dependency-free TypeScript** and are bundled
into both the extension host and the webview.

---

## Building a VSIX

```bash
npm run package        # production bundles
npm run vsix           # -> openplotcnc.vsix
```

CI builds and packages a `.vsix` on `ubuntu-latest`, `windows-latest` and
`macos-latest` for every push and pull request.

---

## Known limitations (v0.1)

- Canned cycles are captured and time-estimated but not fully tool-path-expanded
  (the roughing/finishing passes of `G71`/`G72` are drawn from the profile
  blocks, not synthesised layer by layer).
- Macro variables (`#100`) are not evaluated; bracket expressions with only
  literals are.
- Material removal is represented by the shrinking stock envelope, not a full
  boolean simulation.
- Monaco language worker is loaded best-effort; the editor falls back to
  main-thread tokenisation if the webview origin blocks it.

## License

MIT — see [LICENSE](LICENSE).
