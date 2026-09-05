import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitProgram,
  extractSubprograms,
  truncateAtProgramEnd,
  expandSubprograms,
  isProgramEnd,
} from '../parser';

test('isProgramEnd recognises M30, M02, M2 and M99 but not M198/M290', () => {
  assert.ok(isProgramEnd('M30'));
  assert.ok(isProgramEnd('M02'));
  assert.ok(isProgramEnd('N90 M2'));
  assert.ok(isProgramEnd('M99'));
  assert.ok(!isProgramEnd('M198'));
  assert.ok(!isProgramEnd('M290'));
  assert.ok(!isProgramEnd('(RETURN WITH M99 LATER)'));
});

test('truncateAtProgramEnd keeps the body through the end word', () => {
  const { body, tail } = truncateAtProgramEnd('G0 X1\nG1 Z-5\nM99\nO0100\nG0 X0\nM99');
  assert.equal(body, 'G0 X1\nG1 Z-5\nM99');
  assert.ok(tail.startsWith('O0100'));
});

test('splitProgram: channels end in M99 then $ — bodies cut, subs pooled from tail', () => {
  const src = [
    'O3910(HEADER)',
    '$1',
    'G0 X10',
    'M98 P100',
    'M99',
    '$2',
    'G0 X20',
    'M99',
    '$3',
    'G0 X30',
    'M99',
    'O0100',
    'G1 Z-3 F0.1',
    'M99',
  ].join('\n');

  const { channels, subprograms, trailer } = splitProgram(src, ['$1', '$2', '$3', '$4']);
  assert.deepEqual([...channels.keys()], [1, 2, 3]);
  assert.ok(channels.get(1)!.includes('O3910(HEADER)')); // preamble kept with ch1
  assert.ok(channels.get(1)!.trimEnd().endsWith('M99')); // truncated at its end
  assert.ok(!channels.get(3)!.includes('O0100')); // sub not left in ch3 body
  assert.deepEqual([...subprograms.keys()], [100]);
  assert.ok(trailer.includes('O0100'));
});

test('splitProgram: $0 common/variable section is kept out of the channels', () => {
  const src = [
    'O3910',
    '$1',
    'G0 X10',
    'M99',
    '$2',
    'G0 X20',
    'M99',
    '$0',
    '#814=0000004000',
    '#815=0000003000',
    '%',
  ].join('\n');
  const { channels, trailer } = splitProgram(src, ['$1', '$2', '$3', '$4']);
  assert.deepEqual([...channels.keys()], [1, 2]);
  assert.ok(!channels.get(1)!.includes('#814'));
  assert.ok(!channels.get(2)!.includes('#814'));
  assert.ok(trailer.includes('#814=0000004000'));
});

test('splitProgram: a file with only $0 is treated as one plain program', () => {
  const src = 'O1\n$0\n#500=1\nG0 X1\nM30';
  const { channels } = splitProgram(src, ['$1', '$2', '$3', '$4']);
  assert.deepEqual([...channels.keys()], [1]);
  assert.ok(channels.get(1)!.includes('G0 X1'));
});

test('splitProgram: channels ending in M30 behave the same', () => {
  const src = '$1\nG0 X1\nM30\n$2\nG0 X2\nM30';
  const { channels } = splitProgram(src, ['$1', '$2', '$3', '$4']);
  assert.deepEqual([...channels.keys()], [1, 2]);
  assert.ok(channels.get(1)!.trimEnd().endsWith('M30'));
});

test('extractSubprograms ignores blocks that are really channel programs', () => {
  // O3910 runs to M30 (a main program), O0100 runs to M99 (a sub)
  const src = 'O3910\nG0 X1\nM30\nO0100\nG1 Z-2\nM99';
  const subs = extractSubprograms(src);
  assert.deepEqual([...subs.keys()], [100]);
});

test('expandSubprograms inlines M98 P/L calls with a repeat count', () => {
  const subs = new Map([[100, 'G1 X-0.5 F0.05\nG0 X1']]);
  const out = expandSubprograms('G0 Z0\nM98 P100 L2\nG0 Z5', subs);
  const passes = out.split('\n').filter((l) => l.includes('X-0.5')).length;
  assert.equal(passes, 2);
  assert.ok(!/M98/.test(out.replace(/\(.*\)/g, '')));
});

test('expandSubprograms leaves unknown calls alone and breaks recursion', () => {
  const subs = new Map([[1, 'M98 P1\nG0 X1']]); // self-referential
  const out = expandSubprograms('M98 P1\nM98 P999', subs);
  assert.ok(out.includes('M98 P999')); // unknown untouched
  assert.ok(out.includes('G0 X1')); // expanded once, no infinite loop
});

test('expandSubprograms handles Fanuc packed Prrroooo form', () => {
  const subs = new Map([[100, 'G0 X9']]);
  const out = expandSubprograms('M98 P20100', subs); // 2 repeats of O0100
  assert.equal(out.split('\n').filter((l) => l.includes('X9')).length, 2);
});
