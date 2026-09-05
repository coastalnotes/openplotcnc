/**
 * Time-synchronized multi-channel schedule.
 *
 * Combines the per-channel {@link ChannelTimeline}s with the shared rendezvous
 * barriers so that every channel advances on a single wall clock and *stalls*
 * at a wait code until all participating channels have arrived.
 */

import type {
  ChannelProgram,
  ChannelTimeline,
  MoveSegment,
  MultiChannelProgram,
  SetupConfig,
} from '../types';
import { canonicalBarrierOrder } from '../channels/alignment';
import { solveChannel, type SolveOptions } from '../kinematics/swissTransform';

export interface ScheduledSegment extends MoveSegment {
  tStartWall: number;
  tEndWall: number;
}

export interface ScheduledChannel {
  channel: number;
  segments: ScheduledSegment[];
  /** Wall-clock time this channel finishes all work. */
  endWall: number;
}

export interface ScheduledBarrier {
  id: number;
  /** channel -> wall-clock arrival time. */
  arrivals: Map<number, number>;
  /** channel -> source line of the wait block. */
  lines: Map<number, number>;
  releaseWall: number;
}

export interface Schedule {
  channels: ScheduledChannel[];
  barriers: ScheduledBarrier[];
  duration: number;
}

interface ChannelWaits {
  channel: number;
  /** ordered: barrier id + active-time when the channel reaches the wait block. */
  waits: { id: number; activeTime: number; line: number }[];
}

function channelWaits(
  program: ChannelProgram,
  timeline: ChannelTimeline
): ChannelWaits {
  const waits: ChannelWaits['waits'] = [];
  for (const b of program.blocks) {
    if (!b.sync || b.blockDelete) continue;
    const activeTime = timeline.timeAtBlock[b.index] ?? 0;
    waits.push({ id: b.sync.id, activeTime, line: b.sourceLine });
  }
  return { channel: program.channel, waits };
}

export function buildSchedule(
  program: MultiChannelProgram,
  setup: SetupConfig,
  solveOptions: Partial<SolveOptions> = {}
): Schedule {
  const timelines = new Map<number, ChannelTimeline>();
  const waitInfo = new Map<number, ChannelWaits>();

  for (const cp of program.channels) {
    const tl = solveChannel(cp, setup, solveOptions);
    timelines.set(cp.channel, tl);
    waitInfo.set(cp.channel, channelWaits(cp, tl));
  }

  // Only ids used by >= 2 channels act as barriers.
  const useCount = new Map<number, number>();
  for (const wi of waitInfo.values()) {
    const seen = new Set<number>();
    for (const w of wi.waits) {
      if (!seen.has(w.id)) {
        seen.add(w.id);
        useCount.set(w.id, (useCount.get(w.id) ?? 0) + 1);
      }
    }
  }
  const isBarrier = (id: number) => (useCount.get(id) ?? 0) >= 2;

  const perChannelBarrierIds = program.channels.map((cp) =>
    (waitInfo.get(cp.channel)!.waits.filter((w) => isBarrier(w.id)).map((w) => w.id))
  );
  // Align each rendezvous id only on its first meeting (see alignment.ts).
  const order = [...new Set(canonicalBarrierOrder(perChannelBarrierIds))];

  // Per-channel running state.
  const state = new Map<
    number,
    { wallOffset: number; consumedActive: number; waitPtr: number }
  >();
  for (const cp of program.channels) {
    state.set(cp.channel, { wallOffset: 0, consumedActive: 0, waitPtr: 0 });
  }

  const barriers: ScheduledBarrier[] = [];

  for (const id of order) {
    const arrivals = new Map<number, number>();
    const lines = new Map<number, number>();

    for (const cp of program.channels) {
      const wi = waitInfo.get(cp.channel)!;
      const st = state.get(cp.channel)!;
      // Find this channel's next matching wait at/after its pointer.
      let idx = -1;
      for (let k = st.waitPtr; k < wi.waits.length; k++) {
        if (wi.waits[k].id === id) {
          idx = k;
          break;
        }
      }
      if (idx === -1) continue;
      const w = wi.waits[idx];
      const arriveWall = st.wallOffset + (w.activeTime - st.consumedActive);
      arrivals.set(cp.channel, arriveWall);
      lines.set(cp.channel, w.line);
      // provisionally advance pointer / consumed; wallOffset fixed up after release
      st.waitPtr = idx + 1;
      st.consumedActive = w.activeTime;
      st.wallOffset = arriveWall;
    }

    if (arrivals.size < 2) continue;
    const releaseWall = Math.max(...arrivals.values());
    for (const ch of arrivals.keys()) {
      state.get(ch)!.wallOffset = releaseWall;
    }
    barriers.push({ id, arrivals, lines, releaseWall });
  }

  // Emit scheduled segments per channel using the accumulated stalls.
  const channels: ScheduledChannel[] = [];
  for (const cp of program.channels) {
    const tl = timelines.get(cp.channel)!;
    const wi = waitInfo.get(cp.channel)!;

    // Reconstruct the piecewise offset function: for active-time a, wall = a + stall(a).
    // stall increases by (releaseWall - arrivalWall) at each barrier's active-time.
    const steps: { at: number; addOffset: number }[] = [];
    let ptr = 0;
    let consumed = 0;
    let wallOff = 0;
    for (const b of barriers) {
      const arr = b.arrivals.get(cp.channel);
      const ln = b.lines.get(cp.channel);
      if (arr === undefined || ln === undefined) continue;
      // active time at this wait:
      let waitActive = 0;
      for (let k = ptr; k < wi.waits.length; k++) {
        if (wi.waits[k].id === b.id) {
          waitActive = wi.waits[k].activeTime;
          ptr = k + 1;
          break;
        }
      }
      const arriveWall = wallOff + (waitActive - consumed);
      const stall = b.releaseWall - arriveWall;
      steps.push({ at: waitActive, addOffset: Math.max(stall, 0) });
      consumed = waitActive;
      wallOff = b.releaseWall;
    }

    // A stall is "spent" by segments that start at/after the barrier, but not by
    // the segment that ends exactly on it (that one runs up to the barrier).
    const offsetAt = (activeTime: number, inclusive: boolean): number => {
      let off = 0;
      for (const s of steps) {
        if (inclusive ? activeTime >= s.at - 1e-6 : activeTime > s.at + 1e-6) {
          off += s.addOffset;
        }
      }
      return off;
    };

    const segs: ScheduledSegment[] = tl.segments.map((s) => {
      const tStartActive = s.tEnd - s.durationSec;
      const startOff = offsetAt(tStartActive, true);
      const endOff = offsetAt(s.tEnd, false);
      return {
        ...s,
        tStartWall: tStartActive + startOff,
        tEndWall: s.tEnd + endOff,
      };
    });

    const endWall = segs.length
      ? segs[segs.length - 1].tEndWall
      : tl.activeTime + offsetAt(tl.activeTime, false);
    channels.push({ channel: cp.channel, segments: segs, endWall });
  }

  const duration = Math.max(0, ...channels.map((c) => c.endWall));
  return { channels, barriers, duration };
}

/** Sample every channel's tool position at a wall-clock time. */
export function sampleAt(
  schedule: Schedule,
  timeSec: number
): Map<number, { pos: MoveSegment['to']; segIndex: number; sourceLine: number; waiting: boolean }> {
  const out = new Map<
    number,
    { pos: MoveSegment['to']; segIndex: number; sourceLine: number; waiting: boolean }
  >();

  for (const ch of schedule.channels) {
    if (ch.segments.length === 0) continue;
    let active = ch.segments[0];
    let idx = 0;
    let waiting = false;

    if (timeSec <= ch.segments[0].tStartWall) {
      out.set(ch.channel, {
        pos: ch.segments[0].from,
        segIndex: 0,
        sourceLine: ch.segments[0].sourceLine,
        waiting: false,
      });
      continue;
    }
    if (timeSec >= ch.endWall) {
      const last = ch.segments[ch.segments.length - 1];
      out.set(ch.channel, {
        pos: last.to,
        segIndex: ch.segments.length - 1,
        sourceLine: last.sourceLine,
        waiting: false,
      });
      continue;
    }

    for (let i = 0; i < ch.segments.length; i++) {
      const s = ch.segments[i];
      if (timeSec >= s.tStartWall && timeSec <= s.tEndWall) {
        active = s;
        idx = i;
        waiting = false;
        break;
      }
      if (i < ch.segments.length - 1 && timeSec > s.tEndWall && timeSec < ch.segments[i + 1].tStartWall) {
        active = s;
        idx = i;
        waiting = true; // stalled at a barrier between segments
        break;
      }
    }

    const span = active.tEndWall - active.tStartWall;
    const f = waiting || span < 1e-9 ? 1 : (timeSec - active.tStartWall) / span;
    const pos = {
      x: active.from.x + (active.to.x - active.from.x) * f,
      y: active.from.y + (active.to.y - active.from.y) * f,
      z: active.from.z + (active.to.z - active.from.z) * f,
    };
    out.set(ch.channel, { pos, segIndex: idx, sourceLine: active.sourceLine, waiting });
  }

  return out;
}
