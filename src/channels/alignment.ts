/**
 * Wait-code alignment engine.
 *
 * Given the parsed multi-channel program, produce a row layout in which every
 * shared rendezvous code (`M100`..`M199`, `!L1`..`!Ln`, `WAITCODE n`) sits on the
 * same visual row across all participating channels. The webview turns each row
 * into a Monaco line or an inserted spacer so the columns "lock" at sync points
 * during scroll and edit.
 */

import type { MultiChannelProgram } from '../types';

export interface AlignedCell {
  /** 0-based source line in this channel, or null for an inserted spacer. */
  line: number | null;
}

export interface AlignedRow {
  cells: AlignedCell[]; // one per channel, in ascending channel order
  /** Rendezvous id when this row is a barrier row. */
  barrier?: number;
}

export interface AlignmentResult {
  channels: number[]; // channel ids, ascending
  rows: AlignedRow[];
  barriers: BarrierReport[];
  /** channel id -> (source line -> row index) for quick reverse lookup. */
  lineToRow: Map<number, Map<number, number>>;
}

export interface BarrierReport {
  id: number;
  /** channel id -> source line carrying the sync code. */
  participants: Map<number, number>;
  matched: boolean; // appears in >= 2 channels
  raw: string;
}

interface ChannelMarkers {
  channel: number;
  lineCount: number;
  /** ordered list of (barrierId, sourceLine). */
  markers: { id: number; line: number; raw: string }[];
}

function collectMarkers(program: MultiChannelProgram): ChannelMarkers[] {
  return program.channels.map((ch) => {
    const markers: { id: number; line: number; raw: string }[] = [];
    for (const b of ch.blocks) {
      if (b.sync) markers.push({ id: b.sync.id, line: b.sourceLine, raw: b.sync.raw });
    }
    const lineCount = ch.source.split(/\r?\n/).length;
    return { channel: ch.channel, lineCount, markers };
  });
}

/**
 * Merge each channel's ordered barrier ids into a single canonical order.
 * A barrier is only honoured for alignment when it appears in >= 2 channels.
 */
export function canonicalBarrierOrder(perChannel: number[][]): number[] {
  const pointers = perChannel.map(() => 0);
  const order: number[] = [];
  const total = perChannel.reduce((s, a) => s + a.length, 0);
  let guard = 0;

  const remaining = () => pointers.some((p, i) => p < perChannel[i].length);

  while (remaining() && guard++ < total + 5) {
    const heads = new Set<number>();
    perChannel.forEach((ids, i) => {
      if (pointers[i] < ids.length) heads.add(ids[pointers[i]]);
    });

    let pick: number | undefined;
    for (const id of heads) {
      let blocked = false;
      perChannel.forEach((ids, i) => {
        const at = ids.indexOf(id, pointers[i]);
        if (at !== -1 && ids[pointers[i]] !== id) blocked = true;
      });
      if (!blocked) {
        pick = id;
        break;
      }
    }
    if (pick === undefined) {
      // Conflict — advance the channel with the most work left.
      let best = -1;
      let bestLeft = -1;
      perChannel.forEach((ids, i) => {
        const left = ids.length - pointers[i];
        if (left > bestLeft) {
          bestLeft = left;
          best = i;
        }
      });
      pick = perChannel[best][pointers[best]];
    }

    order.push(pick);
    perChannel.forEach((ids, i) => {
      if (pointers[i] < ids.length && ids[pointers[i]] === pick) pointers[i]++;
    });
  }
  return order;
}

export function alignChannels(program: MultiChannelProgram): AlignmentResult {
  const chans = collectMarkers(program);
  const channelIds = chans.map((c) => c.channel);

  // Count how many channels use each barrier id.
  const useCount = new Map<number, number>();
  for (const c of chans) {
    const seen = new Set<number>();
    for (const m of c.markers) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        useCount.set(m.id, (useCount.get(m.id) ?? 0) + 1);
      }
    }
  }
  const isBarrier = (id: number) => (useCount.get(id) ?? 0) >= 2;

  const perChannelBarrierIds = chans.map((c) =>
    c.markers.filter((m) => isBarrier(m.id)).map((m) => m.id)
  );
  const order = canonicalBarrierOrder(perChannelBarrierIds);

  // First source line for each (channel, barrierId).
  const markerLine = chans.map((c) => {
    const map = new Map<number, { line: number; raw: string }>();
    for (const m of c.markers) {
      if (isBarrier(m.id) && !map.has(m.id)) map.set(m.id, { line: m.line, raw: m.raw });
    }
    return map;
  });

  const cursor = chans.map(() => 0);
  const rows: AlignedRow[] = [];
  const barriers: BarrierReport[] = [];

  const emitInterior = (participantIdx: number[], targetLine: number[]) => {
    const interior = chans.map((_, i) =>
      participantIdx.includes(i) ? Math.max(targetLine[i] - cursor[i], 0) : 0
    );
    const h = Math.max(0, ...interior);
    for (let r = 0; r < h; r++) {
      const cells: AlignedCell[] = chans.map((_, i) => {
        if (!participantIdx.includes(i)) return { line: null };
        const localIdx = r - (h - interior[i]); // bottom-align toward the barrier
        return { line: localIdx >= 0 ? cursor[i] + localIdx : null };
      });
      rows.push({ cells });
    }
    for (const i of participantIdx) cursor[i] = targetLine[i];
  };

  for (const id of order) {
    const participantIdx: number[] = [];
    const targetLine: number[] = chans.map(() => 0);
    const report: BarrierReport = {
      id,
      participants: new Map(),
      matched: true,
      raw: '',
    };

    chans.forEach((_, i) => {
      const hit = markerLine[i].get(id);
      if (hit) {
        participantIdx.push(i);
        targetLine[i] = hit.line;
        report.participants.set(chans[i].channel, hit.line);
        report.raw = report.raw || hit.raw;
      }
    });
    if (participantIdx.length < 2) continue;

    emitInterior(participantIdx, targetLine);

    const barrierCells: AlignedCell[] = chans.map((_, i) =>
      participantIdx.includes(i) ? { line: cursor[i] } : { line: null }
    );
    rows.push({ cells: barrierCells, barrier: id });
    barriers.push(report);

    for (const i of participantIdx) cursor[i] += 1;
  }

  // Trailing content past the final barrier.
  const tailH = Math.max(0, ...chans.map((c, i) => c.lineCount - cursor[i]));
  for (let r = 0; r < tailH; r++) {
    const cells: AlignedCell[] = chans.map((c, i) => {
      const ln = cursor[i] + r;
      return { line: ln < c.lineCount ? ln : null };
    });
    rows.push({ cells });
  }

  // Reverse lookup.
  const lineToRow = new Map<number, Map<number, number>>();
  channelIds.forEach((ch) => lineToRow.set(ch, new Map()));
  rows.forEach((row, ri) => {
    row.cells.forEach((cell, ci) => {
      if (cell.line !== null) lineToRow.get(channelIds[ci])!.set(cell.line, ri);
    });
  });

  return { channels: channelIds, rows, barriers, lineToRow };
}
