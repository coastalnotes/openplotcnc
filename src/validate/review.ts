/**
 * Program review — "run mode as an error detector".
 *
 * Combines the parser's per-block diagnostics with cross-channel checks:
 *   - G-code syntax problems (unbalanced brackets, arcs without a centre,
 *     duplicated addresses, feed moves without a feedrate, …)
 *   - sync codes with no partner in another channel
 *   - sync codes that appear in a different order between two channels
 *   - channels that never reach a program-end word
 *   - cutter compensation / spindle left active at the end
 */

import type { MultiChannelProgram } from '../types';
import { alignChannels } from '../channels/alignment';

export type FindingCategory = 'syntax' | 'sync' | 'motion' | 'program';

export interface Finding {
  severity: 'error' | 'warning' | 'info';
  category: FindingCategory;
  channel: number;
  channelName: string;
  /** 0-based line within the channel. */
  line: number;
  message: string;
}

export interface ReviewResult {
  findings: Finding[];
  errors: number;
  warnings: number;
  infos: number;
}

function categorize(message: string): FindingCategory {
  if (/feed|arc|rapid/i.test(message)) return 'motion';
  if (/sync|line-?up|rendezvous|wait/i.test(message)) return 'sync';
  return 'syntax';
}

export function reviewProgram(program: MultiChannelProgram): ReviewResult {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'channelName'> & { channelName?: string }) => {
    const ch = program.channels.find((c) => c.channel === f.channel);
    findings.push({ ...f, channelName: f.channelName ?? ch?.name ?? `CH${f.channel}` });
  };

  /* ---- 1. parser diagnostics ---- */
  for (const ch of program.channels) {
    for (const b of ch.blocks) {
      for (const d of b.diagnostics) {
        add({
          severity: d.severity === 'info' ? 'info' : d.severity,
          category: categorize(d.message),
          channel: ch.channel,
          line: d.line,
          message: d.message,
        });
      }
    }
  }

  /* ---- 2. sync-code cross-channel checks ---- */
  const multi = program.channels.length >= 2;
  // channel -> ordered [{id, raw, line}]
  const syncs = new Map<number, { id: number; raw: string; line: number }[]>();
  for (const ch of program.channels) {
    syncs.set(
      ch.channel,
      ch.blocks.filter((b) => b.sync).map((b) => ({ id: b.sync!.id, raw: b.sync!.raw, line: b.sourceLine }))
    );
  }

  if (multi) {
    // Which channels use each id.
    const users = new Map<number, number[]>();
    for (const [chId, list] of syncs) {
      for (const s of new Map(list.map((s) => [s.id, s])).values()) {
        users.set(s.id, [...(users.get(s.id) ?? []), chId]);
      }
    }
    for (const [chId, list] of syncs) {
      const reported = new Set<number>();
      for (const s of list) {
        if (reported.has(s.id)) continue;
        reported.add(s.id);
        const who = users.get(s.id) ?? [];
        if (who.length < 2) {
          add({
            severity: 'warning',
            category: 'sync',
            channel: chId,
            line: s.line,
            message: `Sync code ${s.raw} has no matching code in another channel`,
          });
        }
      }
    }

    // Shared codes must appear in the same relative order in both channels.
    const chIds = [...syncs.keys()];
    for (let a = 0; a < chIds.length; a++) {
      for (let b = a + 1; b < chIds.length; b++) {
        const listA = syncs.get(chIds[a])!;
        const listB = syncs.get(chIds[b])!;
        const shared = new Set(
          listA.map((s) => s.id).filter((id) => listB.some((s) => s.id === id))
        );
        const seqA = dedupe(listA.filter((s) => shared.has(s.id)).map((s) => s.id));
        const seqB = dedupe(listB.filter((s) => shared.has(s.id)).map((s) => s.id));
        if (seqA.join(',') !== seqB.join(',')) {
          const first = listA.find((s) => shared.has(s.id));
          add({
            severity: 'warning',
            category: 'sync',
            channel: chIds[a],
            line: first?.line ?? 0,
            message: `Sync codes are in a different order than ${
              program.channels.find((c) => c.channel === chIds[b])?.name ?? `CH${chIds[b]}`
            } — the paths could dead-lock`,
          });
        }
      }
    }
  }

  // Barriers the alignment engine could not line up (belt & suspenders).
  if (multi) {
    for (const barrier of alignChannels(program).barriers) {
      if (!barrier.matched) {
        const [chId, line] = [...barrier.participants.entries()][0] ?? [0, 0];
        add({
          severity: 'warning',
          category: 'sync',
          channel: chId,
          line,
          message: `Sync code ${barrier.raw || barrier.id} could not be aligned`,
        });
      }
    }
  }

  /* ---- 3. program structure ---- */
  for (const ch of program.channels) {
    const last = ch.blocks[ch.blocks.length - 1];
    const endsProperly = ch.blocks.some((b) =>
      b.words.some((w) => w.letter === 'M' && [2, 30, 99].includes(Math.round(w.value)))
    );
    if (!endsProperly) {
      add({
        severity: 'warning',
        category: 'program',
        channel: ch.channel,
        line: last ? last.sourceLine : 0,
        message: 'Channel never reaches a program-end word (M30 / M02 / M99)',
      });
    }
    if (last?.modal.cutterComp && last.modal.cutterComp !== 'off') {
      add({
        severity: 'warning',
        category: 'program',
        channel: ch.channel,
        line: last.sourceLine,
        message: `Cutter compensation (G41/G42) is still active at the end of the channel`,
      });
    }
    if (last?.modal.spindleOn) {
      add({
        severity: 'info',
        category: 'program',
        channel: ch.channel,
        line: last.sourceLine,
        message: 'Spindle is still running at the end of the channel (no M05)',
      });
    }
  }

  findings.sort((a, b) => a.channel - b.channel || a.line - b.line);
  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };
}

function dedupe(xs: number[]): number[] {
  return [...new Set(xs)];
}
