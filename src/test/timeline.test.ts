import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMultiChannel } from '../parser/gcodeParser';
import { buildSchedule, sampleAt } from '../simulation/timeline';
import { defaultSetup } from '../config/defaults';

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

test('a fast channel stalls at the barrier until the slow channel arrives', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 2);
  setup.machine.channels[1].spindle = 'main'; // keep both in the same frame for the test

  // Channel 1: 100 mm at 100 mm/min = 60 s, then M100.
  const ch1 = ['G18 G90 G94', 'G00 X0 Z0', 'G01 Z-100 F100', 'M100', 'G01 Z-110 F100'].join('\n');
  // Channel 2: 10 mm at 100 mm/min = 6 s, then M100.
  const ch2 = ['G18 G90 G94', 'G00 X0 Z0', 'G01 Z-10 F100', 'M100', 'G01 Z-20 F100'].join('\n');

  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'A', source: ch1 },
      { channel: 2, name: 'B', source: ch2 },
    ],
    { dialect: 'fanuc' }
  );
  const sched = buildSchedule(prog, setup, { rapidRate: 60000 });

  assert.equal(sched.barriers.length, 1);
  const b = sched.barriers[0];
  assert.ok(near(b.arrivals.get(1)!, 60, 0.5));
  assert.ok(near(b.arrivals.get(2)!, 6, 0.5));
  assert.ok(near(b.releaseWall, 60, 0.5));

  // At t = 30 s channel 2 has already finished its cut and is waiting.
  const s30 = sampleAt(sched, 30);
  assert.equal(s30.get(2)!.waiting, true);
  assert.equal(s30.get(1)!.waiting, false);

  // Post-barrier move on channel 2 starts only after release (~60 s).
  const seg2after = sched.channels
    .find((c) => c.channel === 2)!
    .segments.at(-1)!;
  assert.ok(seg2after.tStartWall >= 59.5);
});

test('schedule duration covers the slowest path including stalls', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 2);
  setup.machine.channels[1].spindle = 'main';
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'A', source: 'G18 G90 G94\nG00 X0 Z0\nG01 Z-100 F100\nM100' },
      { channel: 2, name: 'B', source: 'G18 G90 G94\nG00 X0 Z0\nG01 Z-10 F100\nM100\nG01 Z-40 F100' },
    ],
    { dialect: 'fanuc' }
  );
  const sched = buildSchedule(prog, setup, { rapidRate: 60000 });
  // ch1 hits barrier at 60 s; ch2 then runs 30 mm / 100 => 18 s more => ~78 s
  assert.ok(sched.duration >= 77 && sched.duration <= 80, `duration ${sched.duration}`);
});
