import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMultiChannel, splitProgram } from '../parser';
import { detectSync } from '../parser/syncCodes';
import { lexLine } from '../parser/gcodeLexer';
import { reviewProgram } from '../validate/review';

const words = (line: string, d: any = 'citizen') =>
  lexLine(line, d).filter((t) => t.type === 'word') as any;

test('G999 is a Citizen sync code, G9xx range', () => {
  const g999 = detectSync('G999', words('G999'), undefined, 'citizen');
  assert.equal(g999?.raw, 'G999');
  const g930 = detectSync('G930', words('G930'), undefined, 'citizen');
  assert.equal(g930?.raw, 'G930');
  // not on fanuc
  assert.equal(detectSync('G999', words('G999', 'fanuc'), undefined, 'fanuc'), undefined);
  // G999 and G600 get distinct ids
  const g600 = detectSync('G600', words('G600'), undefined, 'citizen');
  assert.notEqual(g999!.id, g600!.id);
});

test('review: flags an orphan sync code', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: 'G0 X1\n!L1\nG1 Z-1 F0.1\n!L2\nM99' },
      { channel: 2, name: '$2', source: 'G0 X2\n!L1\nG1 Z-2 F0.1\nM99' }, // no !L2
    ],
    { dialect: 'citizen' }
  );
  const r = reviewProgram(prog);
  const orphan = r.findings.find((f) => /no matching code/.test(f.message));
  assert.ok(orphan, 'orphan sync flagged');
  assert.equal(orphan!.channel, 1);
  assert.equal(orphan!.category, 'sync');
});

test('review: flags out-of-order sync codes', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: '!L1\nG1 X1 F1\n!L2\nM99' },
      { channel: 2, name: '$2', source: '!L2\nG1 X2 F1\n!L1\nM99' },
    ],
    { dialect: 'citizen' }
  );
  const r = reviewProgram(prog);
  assert.ok(r.findings.some((f) => /different order|dead-?lock/i.test(f.message)));
});

test('review: flags syntax errors from the parser', () => {
  const prog = parseMultiChannel(
    [{ channel: 1, name: '$1', source: 'G18\nG2 X10 Z-5\nG1 X[1+2\nM30' }],
    { dialect: 'fanuc' }
  );
  const r = reviewProgram(prog);
  assert.ok(r.errors >= 2); // arc without centre + unbalanced bracket
  assert.ok(r.findings.some((f) => /bracket/i.test(f.message)));
  assert.ok(r.findings.some((f) => /Arc move/i.test(f.message)));
});

test('review: flags a missing feedrate and no program end', () => {
  const prog = parseMultiChannel(
    [{ channel: 1, name: '$1', source: 'G18 G97\nG1 X10 Z-5' }],
    { dialect: 'fanuc' }
  );
  const r = reviewProgram(prog);
  assert.ok(r.findings.some((f) => /feedrate/i.test(f.message)));
  assert.ok(r.findings.some((f) => /program-end/i.test(f.message)));
});

test('review: a clean 2-channel program has no errors or warnings', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: 'G18 G97 S2000 M3\nG0 X10 Z2\n!L1\nG1 Z-10 F0.1\n!L2\nG0 X20\nM5\nM99' },
      { channel: 2, name: '$2', source: 'G18 G97 S2000 M3\nG0 X12 Z2\n!L1\n!L2\nG1 Z-2 F0.1\nG0 X20\nM5\nM99' },
    ],
    { dialect: 'citizen' }
  );
  const r = reviewProgram(prog);
  assert.equal(r.errors, 0, JSON.stringify(r.findings));
  assert.equal(r.warnings, 0, JSON.stringify(r.findings));
});

test('splitProgram: sourceLineMap points back at the original file', () => {
  const src = ['O1(HDR)', '$1', 'G0 X1', 'G1 Z-1 F1', 'M99', '$2', 'G0 X2', 'M99'].join('\n');
  const { channels, sourceLineMap } = splitProgram(src, ['$1', '$2', '$3', '$4']);
  const map1 = sourceLineMap.get(1)!;
  const lines1 = channels.get(1)!.split('\n');
  // channel-1 line for 'G1 Z-1 F1' -> original file line index
  const ci = lines1.indexOf('G1 Z-1 F1');
  assert.equal(src.split('\n')[map1[ci]], 'G1 Z-1 F1');
  // preamble kept its original position
  const pi = lines1.indexOf('O1(HDR)');
  assert.equal(map1[pi], 0);
});
