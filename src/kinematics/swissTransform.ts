/**
 * Swiss / turning kinematics.
 *
 * Converts a parsed {@link ChannelProgram} into world-space {@link MoveSegment}s.
 *
 * Coordinate convention (world frame, millimetres):
 *   +Z  — spindle axis, pointing from the main headstock toward the tools / sub-spindle
 *   +X  — radial "up"
 *   +Y  — lateral (live-tool / Y-axis)
 *
 * Sliding-headstock model (swiss-type):
 *   The static toolpath is drawn in *part space* (worldZ = programmed Z) so the
 *   geometry matches the finished part. The moving main-spindle collet face is
 *   reported per-segment as `headstockZ`, advancing toward the guide bushing as
 *   the program feeds material out:  headstockZ = mainSpindleFaceZ - Z.
 *   In standard-lathe mode the headstock is fixed and `headstockZ` is constant.
 *
 * Sub-spindle channels are solved in the sub frame and mirrored about the
 * pickup plane:  worldZ = subPickupZ - Z2.
 */

import type {
  ChannelProgram,
  ChannelTimeline,
  CoordSpace,
  GcodeBlock,
  MoveSegment,
  Plane,
  SetupConfig,
  Vec3,
} from '../types';

export interface SolveOptions {
  /** Rapid traverse rate, mm/min. */
  rapidRate: number;
  /** Fallback feed when a move has no modal F, mm/min. */
  defaultFeed: number;
  /** Minimum spindle rpm used for per-rev time estimates. */
  minRpm: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  rapidRate: 30000,
  defaultFeed: 200,
  minRpm: 1,
};

interface AxisState {
  X: number; // programmed X (diameter or radius per machine config)
  Y: number;
  Z: number;
  C: number;
}

const TAU = Math.PI * 2;

function radiusOf(xProgrammed: number, diameterMode: boolean): number {
  return diameterMode ? xProgrammed / 2 : xProgrammed;
}

/** Resolve the channel's spindle frame from setup, defaulting by id parity. */
export function channelSpace(setup: SetupConfig, channel: number): CoordSpace {
  const cfg = setup.machine.channels.find((c) => c.id === channel);
  if (cfg) return cfg.spindle;
  return channel % 2 === 0 ? 'sub' : 'main';
}

/**
 * Map a fully-resolved programmed position to a world-space point, honouring the
 * active interpolation transform (none / polar / cylindrical).
 */
export function toWorld(
  pos: AxisState,
  block: GcodeBlock,
  setup: SetupConfig,
  space: CoordSpace
): Vec3 {
  const { diameterMode } = setup.machine;
  const r = radiusOf(pos.X, diameterMode);
  const transform = block.modal.transform;

  let p: Vec3;
  if (transform === 'polar') {
    // G12.1/G13.1 — X and C are Cartesian coordinates in the face plane.
    p = { x: r, y: pos.C, z: pos.Z };
  } else if (transform === 'cylindrical') {
    // G07.1 — C is an angle (deg) wrapped onto a cylinder of radius |X|.
    const a = (pos.C * Math.PI) / 180;
    p = { x: r * Math.cos(a), y: r * Math.sin(a), z: pos.Z };
  } else {
    p = { x: r, y: pos.Y, z: pos.Z };
  }

  // Sub-spindle: mirror about the pickup plane.
  if (space === 'sub') {
    return {
      x: p.x,
      y: p.y,
      z: setup.machine.subSpindle.pickupZ - p.z,
    };
  }
  return p;
}

function headstockZFor(z: number, setup: SetupConfig, space: CoordSpace): number {
  if (space === 'sub') {
    return setup.machine.subSpindle.pickupZ - z;
  }
  if (setup.machine.kinematicsMode === 'swiss-type') {
    return setup.machine.mainSpindleFaceZ - z;
  }
  return setup.machine.mainSpindleFaceZ;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** Effective feed in mm/min for a block. */
function effectiveFeed(block: GcodeBlock, radius: number, opts: SolveOptions): number {
  const f = block.feed ?? opts.defaultFeed;
  if (block.modal.feedMode === 'per-rev') {
    let rpm = block.spindleSpeed ?? opts.minRpm;
    if (block.modal.spindleMode === 'css' && block.spindleSpeed) {
      // S is surface speed (m/min); rpm = vc*1000 / (pi * D)
      const d = Math.max(radius * 2, 0.1);
      rpm = (block.spindleSpeed * 1000) / (Math.PI * d);
    }
    rpm = Math.max(rpm, opts.minRpm);
    return Math.max(f * rpm, 1);
  }
  return Math.max(f, 1);
}

/**
 * Arc geometry in the active plane. Returns world-space centre plus signed sweep
 * (radians). Supports I/J/K offsets and R radius (Fanuc sign convention:
 * R < 0 selects the major arc).
 */
function arcGeometry(
  from: Vec3,
  to: Vec3,
  block: GcodeBlock,
  plane: Plane,
  ccw: boolean
): { center: Vec3; radius: number; sweep: number } | undefined {
  const arc = block.arc;
  if (!arc) return undefined;

  // Plane axes: (u, v) are the in-plane axes, w is the arc normal.
  const axisIndex: Record<Plane, [keyof Vec3, keyof Vec3]> = {
    XY: ['x', 'y'],
    ZX: ['z', 'x'],
    YZ: ['y', 'z'],
  };
  const [ua, va] = axisIndex[plane];

  let cu: number;
  let cv: number;
  if (arc.r !== undefined && Number.isFinite(arc.r)) {
    const rRaw = arc.r;
    const rAbs = Math.abs(rRaw);
    const mx = (from[ua] + to[ua]) / 2;
    const my = (from[va] + to[va]) / 2;
    const dx = to[ua] - from[ua];
    const dy = to[va] - from[va];
    const q = Math.hypot(dx, dy);
    if (q < 1e-9 || q / 2 > rAbs + 1e-6) return undefined;
    const h = Math.sqrt(Math.max(rAbs * rAbs - (q * q) / 4, 0));
    // Perpendicular direction; sign chosen by CCW flag and R sign.
    const sign = (ccw ? 1 : -1) * (rRaw < 0 ? -1 : 1);
    cu = mx + (sign * h * -dy) / q;
    cv = my + (sign * h * dx) / q;
  } else {
    const iOff = plane === 'ZX' ? arc.k ?? 0 : plane === 'YZ' ? arc.j ?? 0 : arc.i ?? 0;
    const jOff = plane === 'ZX' ? arc.i ?? 0 : plane === 'YZ' ? arc.k ?? 0 : arc.j ?? 0;
    // I/J/K on a lathe in diameter mode are still radial offsets (not doubled).
    cu = from[ua] + iOff;
    cv = from[va] + jOff;
  }

  const startAng = Math.atan2(from[va] - cv, from[ua] - cu);
  const endAng = Math.atan2(to[va] - cv, to[ua] - cu);
  const radius = Math.hypot(from[ua] - cu, from[va] - cv);

  let sweep = endAng - startAng;
  if (ccw) {
    if (sweep <= 1e-9) sweep += TAU;
  } else {
    if (sweep >= -1e-9) sweep -= TAU;
  }
  // Full circle when start == end and offsets given.
  if (Math.abs(sweep) < 1e-9 && block.arc && block.arc.r === undefined) {
    sweep = ccw ? TAU : -TAU;
  }

  const center: Vec3 = { ...from };
  center[ua] = cu;
  center[va] = cv;
  return { center, radius, sweep };
}

/** Solve a whole channel program into a timeline of world-space moves. */
export function solveChannel(
  program: ChannelProgram,
  setup: SetupConfig,
  options: Partial<SolveOptions> = {}
): ChannelTimeline {
  const opts = { ...DEFAULT_SOLVE_OPTIONS, ...options };
  const space = channelSpace(setup, program.channel);
  const { diameterMode } = setup.machine;

  const pos: AxisState = { X: 0, Y: 0, Z: 0, C: 0 };
  const segments: MoveSegment[] = [];
  const timeAtBlock: number[] = new Array(program.blocks.length).fill(0);
  let t = 0;

  for (const block of program.blocks) {
    if (block.blockDelete) {
      timeAtBlock[block.index] = t;
      continue;
    }

    // ---- resolve programmed target -------------------------------------
    const prev: AxisState = { ...pos };
    const d = block.modal.distance;
    const applyAbsInc = (cur: number, val: number | undefined) =>
      val === undefined ? cur : d === 'inc' ? cur + val : val;

    pos.X = applyAbsInc(pos.X, block.coords.X);
    pos.Y = applyAbsInc(pos.Y, block.coords.Y);
    pos.Z = applyAbsInc(pos.Z, block.coords.Z);
    pos.C = applyAbsInc(pos.C, block.coords.C);
    // U/V/W are always incremental on turning controls.
    if (block.coords.U !== undefined) pos.X += block.coords.U;
    if (block.coords.V !== undefined) pos.Y += block.coords.V;
    if (block.coords.W !== undefined) pos.Z += block.coords.W;

    // ---- dwell -------------------------------------------------------
    if (block.motion === 'dwell') {
      t += block.dwellSec ?? 0;
      timeAtBlock[block.index] = t;
      continue;
    }

    const moved =
      prev.X !== pos.X || prev.Y !== pos.Y || prev.Z !== pos.Z || prev.C !== pos.C;
    if (!moved || block.motion === 'none') {
      timeAtBlock[block.index] = t;
      continue;
    }

    const from = toWorld(prev, block, setup, space);
    const to = toWorld(pos, block, setup, space);
    const rapid = block.motion === 'rapid';
    const plane = block.modal.plane;
    const radius = radiusOf(pos.X, diameterMode);

    let length: number;
    let center: Vec3 | undefined;

    if (block.motion === 'arc-cw' || block.motion === 'arc-ccw') {
      const geo = arcGeometry(from, to, block, plane, block.motion === 'arc-ccw');
      if (geo) {
        center = geo.center;
        length = Math.abs(geo.sweep) * geo.radius;
      } else {
        length = dist(from, to);
        block.diagnostics.push({
          severity: 'warning',
          message: 'Could not resolve arc geometry; drawn as a straight chord',
          line: block.sourceLine,
          col: 0,
          length: block.raw.length,
        });
      }
    } else {
      length = dist(from, to);
    }

    const feed = rapid ? opts.rapidRate : effectiveFeed(block, radius, opts);
    const rpm =
      block.modal.spindleMode === 'css' && block.spindleSpeed
        ? (block.spindleSpeed * 1000) / (Math.PI * Math.max(radius * 2, 0.1))
        : block.spindleSpeed ?? 0;
    const durationSec = length > 1e-9 ? (length / feed) * 60 : 0;
    t += durationSec;

    segments.push({
      channel: program.channel,
      blockIndex: block.index,
      sourceLine: block.sourceLine,
      motion: block.motion,
      rapid,
      from,
      to,
      center,
      plane,
      space,
      feed,
      spindleRpm: rpm,
      toolId: block.modal.tool || undefined,
      headstockZ: headstockZFor(pos.Z, setup, space),
      length,
      durationSec,
      tEnd: t,
    });
    timeAtBlock[block.index] = t;
  }

  return { channel: program.channel, segments, activeTime: t, timeAtBlock };
}
