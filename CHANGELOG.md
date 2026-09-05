# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-09-05

### Added

- Zero-dependency G-code lexer + parser for the Fanuc and Mitsubishi turning /
  Swiss dialects, emitting a per-block AST with a full modal-state snapshot and
  structured wait/sync tokens.
- Swiss / turning kinematics transform (sliding headstock, guide bushing, main
  vs sub spindle frames, polar & cylindrical interpolation).
- Wait-code alignment engine — shared `M100`–`M199`, `!L1`–`!Ln` and
  `WAITCODE` rendezvous codes align row-for-row across channels.
- Multi-channel Monaco editor (2–4 columns) with scroll/edit locking, spacer
  view-zones and sync-line decorations.
- Three.js backplot viewport with colour-coded channels, dashed rapids, solid
  feeds, true arc geometry, machine geometry and a coordinate gizmo.
- Time-synchronized playback (play/pause/step/scrub, 0.1×–10×) that stalls every
  channel at wait codes until all participants arrive.
- JSON-schema-backed setup UI persisted to `openplotcnc.setup.json`.
- Commands: `openplotcnc.openBackplotter`, `openplotcnc.syncChannels`,
  `openplotcnc.configureTooling`.
- Cross-platform CI (Ubuntu / Windows / macOS) building and packaging a `.vsix`.
- 33 unit tests covering the lexer, parser, sync codes, kinematics, alignment
  and the multi-channel schedule.
