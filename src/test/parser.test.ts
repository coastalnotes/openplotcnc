import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { lexLine, evalExpression } from '../parser/gcodeLexer';
import { parseChannel, parseMultiChannel, splitChannels } from '../parser/gcodeParser';
import { detectSync, decodePathMask } from '../parser/syncCodes';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (p: string) => readFileSync(resolve(here, '../../samples', p), 'utf8');

test('lexer: address words, signs and decimals', () => {
  const toks = lexLine('N10 G01 X-12.5 Z.008 F0.2', 'fanuc');
  const words = toks.filter((t) => t.type === 'word');
  assert.equal(words.find((w) => w.letter === 'X')?.value, -12.5);
  assert.equal(words.find((w) => w.letter === 'Z')?.value, 0.008);
  assert.equal(words.find((w) => w.letter === 'F')?.value, 0.2);
});

test('lexer: comments in both styles', () => {
  const a = lexLine('G00 X1 (rapid to clearance)', 'fanuc');
  assert.equal(a.find((t) => t.type === 'comment')?.raw, '(rapid to clearance)');
  const b = lexLine('G00 X1 ; semicolon comment', 'fanuc');
  assert.equal(b.find((t) => t.type === 'comment')?.raw, '; semicolon comment');
});

test('lexer: Mitsubishi sync directive !L2 and bare ! 3', () => {
  assert.equal(lexLine('!L2', 'mitsubishi').find((t) => t.type === 'sync')?.value, 2);
  assert.equal(lexLine('! 3', 'mitsubishi').find((t) => t.type === 'sync')?.value, 3);
});

test('lexer: channel marker $2 and program number O1001', () => {
  assert.equal(lexLine('$2', 'fanuc')[0].type, 'channelMarker');
  assert.equal(lexLine('O1001', 'fanuc')[0].value, 1001);
  assert.equal(lexLine(':1001', 'fanuc')[0].type, 'programNumber');
});

test('lexer: bracket expression evaluation', () => {
  assert.equal(evalExpression('[2+3*4]'), 14);
  assert.ok(Number.isNaN(evalExpression('[#100+1]')));
  const t = lexLine('X[10/2] Z[#5]', 'fanuc').filter((x) => x.type === 'word');
  assert.equal(t[0].value, 5);
  assert.ok(Number.isNaN(t[1].value));
});

test('syncCodes: Fanuc M100-M199 rendezvous', () => {
  const s = detectSync('M100', lexLine('M100', 'fanuc').filter((t) => t.type === 'word') as any, undefined, 'fanuc');
  assert.equal(s?.kind, 'fanuc-mwait');
  assert.equal(s?.id, 100);
});

test('syncCodes: Fanuc P bitmask wait', () => {
  const words = lexLine('M120 P3', 'fanuc').filter((t) => t.type === 'word') as any;
  const s = detectSync('M120 P3', words, undefined, 'fanuc');
  assert.equal(s?.kind, 'fanuc-pwait');
  assert.deepEqual(s?.partners, [1, 2]);
  assert.deepEqual(decodePathMask(6), [2, 3]);
});

test('syncCodes: WAITCODE alias', () => {
  const s = detectSync('WAITCODE 12', [], undefined, 'fanuc');
  assert.equal(s?.id, 12);
  assert.equal(s?.kind, 'fanuc-waitcode');
});

test('parser: modal state carries units, plane, distance, wcs', () => {
  const prog = parseChannel(
    ['G20 G18', 'G90 G54', 'G01 X1 Z2 F10', 'G00 X5'].join('\n'),
    1,
    'P1',
    { dialect: 'fanuc' }
  );
  const last = prog.blocks.at(-1)!;
  assert.equal(last.modal.units, 'inch');
  assert.equal(last.modal.plane, 'ZX');
  assert.equal(last.modal.distance, 'abs');
  assert.equal(last.modal.wcs, 'G54');
  assert.equal(last.motion, 'rapid');
});

test('parser: motion is modal across blocks', () => {
  const prog = parseChannel(['G01 X1 F5', 'X2', 'Z3'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  assert.deepEqual(prog.blocks.map((b) => b.motion), ['linear', 'linear', 'linear']);
});

test('parser: G96 CSS and spindle direction', () => {
  const prog = parseChannel(['G96 S200 M03', 'G01 X1 F0.1'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  assert.equal(prog.blocks.at(-1)!.modal.spindleMode, 'css');
  assert.equal(prog.blocks.at(-1)!.modal.spindleOn, true);
  assert.equal(prog.blocks.at(-1)!.modal.spindleCw, true);
});

test('parser: G12.1 polar / G07.1 cylindrical transforms', () => {
  const prog = parseChannel(
    ['G12.1', 'G01 X5 C10 F1', 'G13.1', 'G07.1 C15', 'G01 Z1', 'G07.1 C0'].join('\n'),
    1,
    'P1',
    { dialect: 'fanuc' }
  );
  assert.equal(prog.blocks[1].modal.transform, 'polar');
  assert.equal(prog.blocks[2].modal.transform, 'none');
  assert.equal(prog.blocks[4].modal.transform, 'cylindrical');
  assert.equal(prog.blocks[4].modal.cylinderRadius, 15);
  assert.equal(prog.blocks[5].modal.transform, 'none');
});

test('parser: G71 roughing cycle captures profile range', () => {
  const src = [
    'G71 U1 R0.5',
    'G71 P100 Q110 U0.3 W0.1 F0.2',
    'N100 G00 X8',
    'N110 G01 Z-40',
  ].join('\n');
  const prog = parseChannel(src, 1, 'P1', { dialect: 'fanuc' });
  const cyc = prog.blocks.find((b) => b.cycle?.code === 'G71' && b.cycle.profileRange);
  assert.ok(cyc);
  assert.deepEqual(cyc!.cycle!.profileRange, [100, 110]);
  assert.equal(cyc!.cycle!.kind, 'rough-turn');
});

test('parser: dwell G04 P500 -> 0.5s', () => {
  const prog = parseChannel('G04 P500', 1, 'P1', { dialect: 'fanuc' });
  assert.equal(prog.blocks[0].motion, 'dwell');
  assert.equal(prog.blocks[0].dwellSec, 0.5);
});

test('parser: arc without I/J/K/R is flagged', () => {
  const prog = parseChannel(['G18', 'G02 X10 Z-5'].join('\n'), 1, 'P1', {
    dialect: 'fanuc',
  });
  assert.ok(prog.diagnostics.some((d) => /Arc move without/.test(d.message)));
});

test('splitChannels: single-file $1..$3', () => {
  const map = splitChannels(sample('single-file/PROGRAM.NC'), ['$1', '$2', '$3', '$4']);
  assert.deepEqual([...map.keys()].sort(), [1, 2, 3]);
  assert.ok(map.get(2)!.includes('G30 U0 W0'));
});

test('parseMultiChannel: Fanuc swiss sample parses both paths with sync tokens', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-fanuc/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-fanuc/PATH2.NC') },
    ],
    { dialect: 'fanuc' }
  );
  const syncsCh1 = prog.channels[0].blocks.filter((b) => b.sync).map((b) => b.sync!.id);
  const syncsCh2 = prog.channels[1].blocks.filter((b) => b.sync).map((b) => b.sync!.id);
  assert.ok(syncsCh1.includes(100) && syncsCh1.includes(105));
  assert.ok(syncsCh2.includes(100) && syncsCh2.includes(105));
});

test('parseMultiChannel: Mitsubishi !Ln sync tokens', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-mitsubishi/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-mitsubishi/PATH2.NC') },
    ],
    { dialect: 'mitsubishi' }
  );
  for (const ch of prog.channels) {
    const ids = ch.blocks.filter((b) => b.sync).map((b) => b.sync!.id);
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(ch.blocks.find((b) => b.sync)!.sync!.kind, 'mitsubishi-L');
  }
});
