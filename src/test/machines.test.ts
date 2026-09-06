import test from 'node:test';
import assert from 'node:assert/strict';

import { MACHINE_TEMPLATES, getTemplate, templateSetup } from '../machines';
import { helpSections } from '../help/content';
import { parseMultiChannel } from '../parser';
import { buildSchedule } from '../simulation/timeline';

test('templates: Citizen L12-VII and L12-X are present and well-formed', () => {
  for (const id of ['citizen-l12vii', 'citizen-l12x']) {
    const t = getTemplate(id)!;
    assert.ok(t, `${id} exists`);
    assert.equal(t.setup.machine.dialect, 'citizen');
    assert.equal(t.setup.machine.kinematicsMode, 'swiss-type');
    assert.equal(t.setup.template, id);
    assert.ok(t.setup.tools.length >= 10, `${id} has a standard tool list`);
    assert.ok(t.setup.machine.channels.length >= 2);
    assert.ok(t.notes.length > 0);
    // tools reference valid channels
    for (const tool of t.setup.tools) {
      assert.ok(t.setup.machine.channels.some((c) => c.id === tool.channel));
    }
  }
});

test('templates: L12-X exposes the Y2 axis, VII does not', () => {
  assert.ok(getTemplate('citizen-l12x')!.axes.includes('Y2'));
  assert.ok(!getTemplate('citizen-l12vii')!.axes.includes('Y2'));
});

test('templates: carry a machine geometry for the 3D model', () => {
  const x = getTemplate('citizen-l12x')!.setup.machine.geometry!;
  assert.equal(x.model, 'Citizen Cincom L12-X');
  assert.equal(x.mainSpindle.maxRpm, 15000);
  assert.equal(x.mainSpindle.collet, 'FC096-M');
  assert.equal(x.subSpindle.maxRpm, 12000);
  assert.ok(x.subSpindle.y2Stroke > 0);
  assert.equal(getTemplate('citizen-l12vii')!.setup.machine.geometry!.subSpindle.y2Stroke, 0);
  assert.ok(x.gangPost.turningStations >= 5);
  assert.ok(x.backPost.rotaryStations === 4 && x.backPost.fixedStations === 4);
});

test('a setup round-trips its geometry through normalizeSetup', async () => {
  const { normalizeSetup } = await import('../config/schema');
  const { templateSetup } = await import('../machines');
  const seed = templateSetup('citizen-l12x')!;
  const { setup } = normalizeSetup(JSON.parse(JSON.stringify(seed)));
  assert.equal(setup.machine.geometry!.mainSpindle.maxRpm, 15000);
  assert.equal(setup.machine.geometry!.model, 'Citizen Cincom L12-X');
});

test('templates: every template has a unique id and a generic fallback exists', () => {
  const ids = MACHINE_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('generic-swiss-fanuc'));
  assert.ok(ids.includes('generic-lathe-fanuc'));
});

test('templateSetup returns a deep copy', () => {
  const a = templateSetup('citizen-l12vii')!;
  a.stock.outerDiameter = 999;
  const b = templateSetup('citizen-l12vii')!;
  assert.equal(b.stock.outerDiameter, 12);
});

test('a Citizen program with $ sections and !L codes schedules on the L12-VII template', () => {
  const src = [
    'O100',
    '$1',
    'G0 X12 Z2',
    '!1L1',
    'G1 Z-10 F0.1',
    '!12L2',
    'M99',
    '$2',
    'G0 X20 Z5',
    '!2L1',
    '!12L2',
    'G1 Z-2 F0.1',
    'M99',
  ].join('\n');

  const split = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: 'G0 X12 Z2\n!1L1\nG1 Z-10 F0.1\n!12L2\nM99' },
      { channel: 2, name: '$2', source: 'G0 X20 Z5\n!2L1\n!12L2\nG1 Z-2 F0.1\nM99' },
    ],
    { dialect: 'citizen' }
  );
  const sched = buildSchedule(split, templateSetup('citizen-l12vii')!);
  assert.equal(sched.barriers.map((b) => b.id).sort().join(','), '1,2');
  assert.ok(sched.duration > 0);
  void src;
});

test('help content is dialect-aware', () => {
  const fanuc = helpSections('fanuc').find((s) => s.id === 'sync')!;
  const citizen = helpSections('citizen').find((s) => s.id === 'sync')!;
  assert.match(fanuc.title, /Fanuc/);
  assert.match(citizen.title, /Citizen/);
  assert.ok(citizen.codes!.some((c) => /M600/.test(c.code)));

  const withMachine = helpSections('citizen', getTemplate('citizen-l12x'));
  assert.ok(withMachine.some((s) => s.id === 'machine'));
});
