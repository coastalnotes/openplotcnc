import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseMultiChannel } from '../parser';
import { alignChannels } from '../channels/alignment';
import { buildSchedule, sampleAt } from '../simulation/timeline';
import { solveChannel } from '../kinematics/swissTransform';
import { defaultSetup } from '../config/defaults';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (p: string) => readFileSync(resolve(here, '../../samples', p), 'utf8');

function loadFanucSwiss() {
  return parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-fanuc/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-fanuc/PATH2.NC') },
    ],
    { dialect: 'fanuc' }
  );
}

test('end-to-end: Fanuc swiss sample parses, aligns, solves and schedules', () => {
  const prog = loadFanucSwiss();
  const setup = defaultSetup('swiss-type', 'fanuc', 2);

  // alignment: M100 and M105 matched across both channels
  const align = alignChannels(prog);
  const matched = align.barriers.filter((b) => b.matched).map((b) => b.id);
  assert.deepEqual(matched, [100, 105]);

  // kinematics: both channels produce world-space geometry
  const mainTl = solveChannel(prog.channels[0], setup);
  const subTl = solveChannel(prog.channels[1], setup);
  assert.ok(mainTl.segments.length > 0);
  assert.ok(subTl.segments.length > 0);
  // sub-spindle geometry sits on the far side of the pickup plane
  assert.ok(subTl.segments.every((s) => s.space === 'sub'));

  // schedule: single wall clock, both channels stall at M100
  const sched = buildSchedule(prog, setup);
  assert.ok(sched.duration > 0);
  const b100 = sched.barriers.find((b) => b.id === 100)!;
  assert.equal(b100.arrivals.size, 2);
});

test('end-to-end: scrubbing advances every channel and locks at the barrier', () => {
  const prog = loadFanucSwiss();
  const setup = defaultSetup('swiss-type', 'fanuc', 2);
  const sched = buildSchedule(prog, setup);

  const b100 = sched.barriers.find((b) => b.id === 100)!;
  const justBefore = b100.releaseWall - 1e-3;

  // Sub channel (fast: only a rapid home) reaches the barrier well before Main.
  assert.ok(b100.arrivals.get(2)! <= b100.arrivals.get(1)! + 1e-6);

  const midway = sampleAt(sched, Math.max(0.01, justBefore / 2));
  assert.equal(midway.size, 2, 'both channels sampled');

  // Every sampled tool position is finite.
  for (const st of midway.values()) {
    assert.ok(Number.isFinite(st.pos.x) && Number.isFinite(st.pos.y) && Number.isFinite(st.pos.z));
  }

  // At the end everything has run to completion.
  const atEnd = sampleAt(sched, sched.duration);
  for (const st of atEnd.values()) assert.equal(st.waiting, false);
});

test('end-to-end: Mitsubishi !Ln sample schedules with 3 barriers', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-mitsubishi/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-mitsubishi/PATH2.NC') },
    ],
    { dialect: 'mitsubishi' }
  );
  const setup = defaultSetup('swiss-type', 'mitsubishi', 2);
  const sched = buildSchedule(prog, setup);
  assert.deepEqual(sched.barriers.map((b) => b.id), [1, 2, 3]);
});
