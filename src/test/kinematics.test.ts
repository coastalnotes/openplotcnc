import test from 'node:test';
import assert from 'node:assert/strict';

import { parseChannel } from '../parser/gcodeParser';
import { solveChannel, toWorld, channelSpace } from '../kinematics/swissTransform';
import { defaultSetup } from '../config/defaults';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('diameter mode halves X into a radius', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  const prog = parseChannel(['G18 G90', 'G00 X20 Z0', 'G01 Z-10 F100'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  const tl = solveChannel(prog, setup);
  assert.ok(tl.segments.length >= 1);
  assert.ok(near(tl.segments[0].to.x, 10)); // 20 dia -> 10 radius
});

test('feed-per-minute time estimate', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  const prog = parseChannel(
    ['G18 G90 G94', 'G00 X0 Z0', 'G01 Z-100 F1000'].join('\n'),
    1,
    'P1',
    { dialect: 'fanuc' }
  );
  const tl = solveChannel(prog, setup);
  const feedSeg = tl.segments.find((s) => !s.rapid)!;
  assert.ok(near(feedSeg.durationSec, (100 / 1000) * 60, 1e-3)); // 6 s
});

test('feed-per-rev uses spindle rpm', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  const prog = parseChannel(
    ['G18 G90 G95 G97 S2000 M03', 'G00 X0 Z0', 'G01 Z-100 F0.2'].join('\n'),
    1,
    'P1',
    { dialect: 'fanuc' }
  );
  const tl = solveChannel(prog, setup);
  const feedSeg = tl.segments.find((s) => !s.rapid)!;
  // 0.2 mm/rev * 2000 rpm = 400 mm/min -> 100 mm => 15 s
  assert.ok(near(feedSeg.durationSec, 15, 1e-2));
});

test('sliding headstock advances toward the guide bushing (swiss)', () => {
  const setup = defaultSetup('swiss-type', 'fanuc', 1);
  const prog = parseChannel(['G18 G90', 'G00 X0 Z0', 'G01 Z-50 F200'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  const tl = solveChannel(prog, setup);
  const seg = tl.segments.find((s) => !s.rapid)!;
  // headstockZ = mainSpindleFaceZ - Z = -20 - (-50) = 30
  assert.ok(near(seg.headstockZ, 30));
});

test('standard lathe keeps the headstock fixed', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  const prog = parseChannel(['G18 G90', 'G01 Z-50 F200'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  const tl = solveChannel(prog, setup);
  assert.ok(near(tl.segments.at(-1)!.headstockZ, setup.machine.mainSpindleFaceZ));
});

test('sub-spindle frame mirrors about the pickup plane', () => {
  const setup = defaultSetup('swiss-type', 'fanuc', 2);
  const space = channelSpace(setup, 2);
  assert.equal(space, 'sub');
  const block = parseChannel('G18 G90\nG01 X10 Z5 F100', 2, 'P2', { dialect: 'fanuc' })
    .blocks.at(-1)!;
  const w = toWorld({ X: 10, Y: 0, Z: 5, C: 0 }, block, setup, 'sub');
  assert.ok(near(w.z, setup.machine.subSpindle.pickupZ - 5));
  assert.ok(near(w.x, 5)); // diameter mode -> radius
});

test('G02 arc length is the true arc, not the chord', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  // Quarter circle radius 10 in the ZX plane.
  const prog = parseChannel(
    ['G18 G90 G94', 'G00 X0 Z0', 'G03 X20 Z-10 K-10 F100'].join('\n'),
    1,
    'P1',
    { dialect: 'fanuc' }
  );
  const tl = solveChannel(prog, setup);
  const arc = tl.segments.find((s) => s.motion.startsWith('arc'))!;
  assert.ok(arc.center);
  // radius 10 quarter turn -> pi/2 * 10 ~= 15.708
  assert.ok(near(arc.length, (Math.PI / 2) * 10, 0.2));
});

test('cylindrical interpolation wraps C onto the cylinder surface', () => {
  const setup = defaultSetup('standard-lathe', 'fanuc', 1);
  const block = parseChannel('G18\nG07.1 C10\nG01 X20 C90 Z0 F100', 1, 'P1', {
    dialect: 'fanuc',
  }).blocks.at(-1)!;
  assert.equal(block.modal.transform, 'cylindrical');
  const w = toWorld({ X: 20, Y: 0, Z: 0, C: 90 }, block, setup, 'main');
  // radius 10, angle 90deg -> x ~ 0, y ~ 10
  assert.ok(Math.abs(w.x) < 1e-6);
  assert.ok(near(w.y, 10, 1e-6));
});
