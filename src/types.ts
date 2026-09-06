/**
 * OpenPlotCNC — shared domain model.
 *
 * These types are consumed by BOTH the extension host and the webview bundle,
 * so this file must stay free of `vscode` and DOM imports.
 */

export type Dialect = 'fanuc' | 'mitsubishi' | 'citizen';

export type KinematicsMode = 'standard-lathe' | 'swiss-type';

export type Units = 'mm' | 'inch';

export type Plane = 'XY' | 'ZX' | 'YZ';

export type DistanceMode = 'abs' | 'inc';

export type SpindleMode = 'rpm' | 'css';

export type CompMode = 'off' | 'left' | 'right';

export type LengthCompMode = 'off' | 'positive' | 'negative';

/** Cartesian point. Units follow the active program units. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type MotionType =
  | 'rapid' // G00
  | 'linear' // G01
  | 'arc-cw' // G02
  | 'arc-ccw' // G03
  | 'dwell' // G04
  | 'none';

/** A single address word, e.g. `G01`, `X-12.5`, `F0.08`, `S1=6682`. */
export interface Word {
  /** Upper-case address letter. */
  letter: string;
  /** Numeric value, or `NaN` when the address had no parseable number. */
  value: number;
  /** Spindle / axis index for Citizen indexed assignments (`S1=6682` → 1). */
  index?: number;
  /** Raw text as it appeared in the source. */
  raw: string;
  /** Column offset within the source line. */
  col: number;
}

export type SyncKind =
  | 'fanuc-mwait' // M100..M199 rendezvous
  | 'fanuc-pwait' // M-code + P<mask> (wait on channels in bitmask)
  | 'fanuc-waitcode' // literal WAITCODE macro alias
  | 'mitsubishi-L'; // !L1..!Ln  /  ! <n>

export interface SyncToken {
  kind: SyncKind;
  /** The rendezvous identifier used to match blocks across channels. */
  id: number;
  /** Channels this block waits for. Empty = "all active channels". */
  partners: number[];
  /** Raw source text of the sync directive. */
  raw: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  col: number;
  length: number;
}

/** Canned-cycle descriptor for lathe roughing/threading cycles. */
export interface CannedCycle {
  code: string; // 'G71' | 'G72' | 'G76' | 'G70' | 'G74' | 'G75' | 'G92' | 'G90'
  kind: 'rough-turn' | 'rough-face' | 'thread' | 'finish' | 'peck' | 'groove' | 'simple';
  params: Record<string, number>;
  /** Line indices (within the channel) of the profile blocks this cycle expands. */
  profileRange?: [number, number];
}

/** Modal machine state captured *after* a block executes. */
export interface ModalState {
  motion: MotionType;
  plane: Plane;
  units: Units;
  distance: DistanceMode;
  arcDistance: DistanceMode; // G90.1 / G91.1
  feedMode: 'per-min' | 'per-rev' | 'inverse-time';
  wcs: string; // 'G54'..'G59', 'G54.1P3', 'MACHINE'
  cutterComp: CompMode;
  lengthComp: LengthCompMode;
  toolOffset: number;
  tool: string; // active T word, e.g. 'T0101'
  spindleMode: SpindleMode;
  spindleOn: boolean;
  spindleCw: boolean;
  coolant: boolean;
  /** Polar / cylindrical interpolation transform active on this channel. */
  transform: 'none' | 'polar' | 'cylindrical';
  cylinderRadius: number;
}

export interface GcodeBlock {
  /** 1-based channel id (1..4). */
  channel: number;
  /** 0-based index of this block within its channel program. */
  index: number;
  /** 0-based line number within the physical source file. */
  sourceLine: number;
  raw: string;
  /** Leading `/` block-delete. */
  blockDelete: boolean;
  words: Word[];
  comment?: string;
  /** Program number header (`O1001`, `:1001`). */
  programNumber?: number;
  /** Sequence number (`N…`). */
  n?: number;

  motion: MotionType;
  /** Target coordinates *as programmed* (absolute or incremental per modal). */
  coords: Partial<Record<'X' | 'Y' | 'Z' | 'U' | 'V' | 'W' | 'C' | 'A' | 'B', number>>;
  /** Arc centre offsets / radius. */
  arc?: { i?: number; j?: number; k?: number; r?: number };
  feed?: number;
  spindleSpeed?: number;
  dwellSec?: number;

  sync?: SyncToken;
  cycle?: CannedCycle;

  /** Modal state snapshot after this block. */
  modal: ModalState;
  diagnostics: Diagnostic[];
}

export interface ChannelProgram {
  channel: number;
  name: string;
  /** Physical source (single file, or the slice belonging to this channel). */
  source: string;
  uri?: string;
  blocks: GcodeBlock[];
  diagnostics: Diagnostic[];
}

export interface MultiChannelProgram {
  dialect: Dialect;
  channels: ChannelProgram[];
}

/* ------------------------------------------------------------------ *
 *  Geometry produced by the kinematics pass
 * ------------------------------------------------------------------ */

export type CoordSpace = 'main' | 'sub';

export interface MoveSegment {
  channel: number;
  /** Index of the source block within the channel program. */
  blockIndex: number;
  sourceLine: number;
  motion: MotionType;
  rapid: boolean;
  /** Start / end in a common world frame (mm). */
  from: Vec3;
  to: Vec3;
  /** Arc centre in world frame, when motion is an arc. */
  center?: Vec3;
  plane: Plane;
  /** Which spindle frame this move belongs to. */
  space: CoordSpace;
  feed: number; // mm/min effective
  spindleRpm: number;
  toolId?: string;
  /** Sliding-headstock Z (world) while this move executes (swiss mode). */
  headstockZ: number;
  /** Path length (mm). */
  length: number;
  /** Execution time for this move in seconds (feed / rapid based). */
  durationSec: number;
  /** Cumulative time on this channel at the *end* of this move. */
  tEnd: number;
}

export interface SyncPoint {
  id: number;
  /** channel -> block index that carries the sync token. */
  blocks: Map<number, number>;
  /** channel -> cumulative time when that channel reaches the barrier. */
  arrival: Map<number, number>;
  /** Wall-clock time when every channel has cleared the barrier. */
  releaseAt: number;
}

export interface ChannelTimeline {
  channel: number;
  segments: MoveSegment[];
  /** Total programmed time on this channel (excluding wait stalls). */
  activeTime: number;
  /** Cumulative active time (s) after each block, indexed by block index. */
  timeAtBlock: number[];
}

export interface SimulationModel {
  channels: ChannelTimeline[];
  syncPoints: SyncPoint[];
  /** Total wall-clock duration including wait stalls. */
  duration: number;
}

/* ------------------------------------------------------------------ *
 *  Setup / configuration
 * ------------------------------------------------------------------ */

export interface ChannelConfig {
  id: number;
  name: string;
  spindle: CoordSpace;
  color: string;
  /** Workspace-relative file for multi-file projects. */
  file?: string;
  /** Section marker for single-file projects (`$1`, `O1001`). */
  marker?: string;
}

export interface MachineConfig {
  kinematicsMode: KinematicsMode;
  dialect: Dialect;
  /** X words are diameters (true) or radii (false). */
  diameterMode: boolean;
  units: Units;
  /** World Z of the guide-bushing front face (swiss). */
  guideBushingZ: number;
  /** World Z of the main-spindle collet face when Z1 = 0. */
  mainSpindleFaceZ: number;
  subSpindle: {
    enabled: boolean;
    /** World Z of the sub-spindle collet face when parked. */
    homeZ: number;
    /** World Z of the sub-spindle collet face at part pickup. */
    pickupZ: number;
  };
  channels: ChannelConfig[];
}

export interface StockConfig {
  outerDiameter: number;
  innerDiameter: number; // 0 = solid
  length: number;
  /** Stock protrusion past the guide bushing / collet at program start. */
  protrusion: number;
  material?: string;
}

export type ToolType =
  | 'od-turn'
  | 'id-bore'
  | 'part-off'
  | 'groove'
  | 'thread'
  | 'drill'
  | 'endmill-radial'
  | 'endmill-axial'
  | 'tap';

export interface ToolDef {
  id: string;
  channel: number;
  station: string; // 'T0101', 'T12', gang-post label
  type: ToolType;
  orientation: CoordSpace | 'radial' | 'axial';
  noseRadius?: number;
  width?: number; // grooving / parting blade
  diameter?: number; // rotary tools
  length?: number;
  color?: string;
}

export interface SetupConfig {
  version: 1;
  /** Id of the machine template this setup was seeded from, if any. */
  template?: string;
  machine: MachineConfig;
  stock: StockConfig;
  tools: ToolDef[];
}

/** A loadable machine definition — standard axes, tool stations, kinematics. */
export interface MachineTemplate {
  id: string;
  name: string;
  vendor: string;
  summary: string;
  /** Reference URL / documentation note. */
  reference: string;
  /** Machine-specific programming notes shown in the help panel. */
  notes: string[];
  /** Controlled axis names, for reference display. */
  axes: string[];
  setup: SetupConfig;
}

/* ------------------------------------------------------------------ *
 *  IPC
 * ------------------------------------------------------------------ */

export interface ChannelPayload {
  id: number;
  name: string;
  text: string;
  uri?: string;
}

export type HostToWebview =
  | {
      type: 'init';
      setup: SetupConfig;
      channels: ChannelPayload[];
      subprograms: Record<number, string>;
      program: string;
      mode: 'single-file' | 'multi-file';
      theme: 'light' | 'dark';
    }
  | {
      type: 'channels';
      channels: ChannelPayload[];
      subprograms: Record<number, string>;
      program: string;
      mode: 'single-file' | 'multi-file';
    }
  | { type: 'setup'; setup: SetupConfig }
  | { type: 'revealLine'; channel: number; line: number }
  | { type: 'openConfig' }
  | { type: 'setLayout'; layout: 'split' | 'editor' | '3d' }
  | { type: 'theme'; theme: 'light' | 'dark' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'requestChannels' }
  | { type: 'pickProgram' }
  | { type: 'pickMachine' }
  | { type: 'loadMachine'; templateId: string }
  | { type: 'edit'; channel: number; text: string; uri?: string }
  | { type: 'cursor'; channel: number; line: number }
  | { type: 'openConfig' }
  | { type: 'saveSetup'; setup: SetupConfig }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
