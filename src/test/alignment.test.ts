import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseMultiChannel } from '../parser/gcodeParser';
import { alignChannels, canonicalBarrierOrder } from '../channels/alignment';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (p: string) =>
  readFileSync(resolve(here, '../../samples', p), 'utf8');

test('canonicalBarrierOrder merges shared ids in program order', () => {
  assert.deepEqual(canonicalBarrierOrder([[1, 2, 3], [1, 2, 3]]), [1, 2, 3]);
  assert.deepEqual(canonicalBarrierOrder([[1, 3], [1, 2, 3]]), [1, 2, 3]);
});

test('shared wait codes land on the same row across channels', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-fanuc/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-fanuc/PATH2.NC') },
    ],
    { dialect: 'fanuc' }
  );
  const result = alignChannels(prog);

  for (const barrier of result.barriers.filter((b) => b.matched)) {
    const rowIdx = result.rows.findIndex((r) => r.barrier === barrier.id);
    assert.ok(rowIdx >= 0, `barrier ${barrier.id} has a row`);
    const row = result.rows[rowIdx];
    // Every participating channel occupies this row (non-null cell).
    for (const ch of barrier.participants.keys()) {
      const col = result.channels.indexOf(ch);
      assert.notEqual(row.cells[col].line, null, `channel ${ch} present at barrier ${barrier.id}`);
    }
  }
});

test('M100 and M105 are detected as matched barriers', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-fanuc/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-fanuc/PATH2.NC') },
    ],
    { dialect: 'fanuc' }
  );
  const ids = alignChannels(prog).barriers.filter((b) => b.matched).map((b) => b.id);
  assert.ok(ids.includes(100));
  assert.ok(ids.includes(105));
});

test('Mitsubishi !L1..!L3 align line-for-line across 2 channels', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-mitsubishi/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-mitsubishi/PATH2.NC') },
    ],
    { dialect: 'mitsubishi' }
  );
  const result = alignChannels(prog);
  assert.deepEqual(
    result.barriers.map((b) => b.id),
    [1, 2, 3]
  );
  // rows are monotonic per channel (no reordering of source lines)
  for (const ch of result.channels) {
    const map = result.lineToRow.get(ch)!;
    const lines = [...map.keys()].sort((a, b) => a - b);
    let prevRow = -1;
    for (const ln of lines) {
      const row = map.get(ln)!;
      assert.ok(row > prevRow, `channel ${ch} line ${ln} row ${row} after ${prevRow}`);
      prevRow = row;
    }
  }
});

test('a rendezvous code that repeats does not collapse later spacers', () => {
  // CH1 is much longer than CH2 between G630 and !L300; G600 repeats at the end.
  const ch1 = [
    'G600',
    'G630',
    ...Array.from({ length: 120 }, (_, i) => `G1 X${i} F0.1`),
    '!L300',
    'G1 X0',
    'G600',
    'M99',
  ].join('\n');
  const ch2 = ['G600', 'G630', 'G1 X5', '!L300', 'G1 X0', 'M99'].join('\n');

  const prog = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: ch1 },
      { channel: 2, name: '$2', source: ch2 },
    ],
    { dialect: 'citizen' }
  );
  const result = alignChannels(prog);

  // !L300 must land on the same row in both channels.
  const l300 = result.barriers.find((b) => b.raw === '!L300')!;
  assert.ok(l300 && l300.matched);
  const rowIdx = result.rows.findIndex((r) => r.barrier === l300.id);
  const c1 = result.channels.indexOf(1);
  const c2 = result.channels.indexOf(2);
  assert.notEqual(result.rows[rowIdx].cells[c1].line, null);
  assert.notEqual(result.rows[rowIdx].cells[c2].line, null);

  // CH2 got ~117 spacer rows before its !L300 (row index >> its source line).
  const ch2L300Row = result.lineToRow.get(2)!.get(3)!; // 0-based source line 3 = !L300
  assert.ok(ch2L300Row > 100, `expected big offset, got ${ch2L300Row}`);
});

test('G600 appears once in the barrier list even when repeated', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: '$1', source: 'G600\nG1 X1\nG600\nM99' },
      { channel: 2, name: '$2', source: 'G600\nG1 X2\nG600\nM99' },
    ],
    { dialect: 'citizen' }
  );
  const raws = alignChannels(prog).barriers.map((b) => b.raw);
  assert.deepEqual(raws, ['G600']);
});

test('every row has one cell per channel', () => {
  const prog = parseMultiChannel(
    [
      { channel: 1, name: 'Main', source: sample('swiss-fanuc/PATH1.NC') },
      { channel: 2, name: 'Sub', source: sample('swiss-fanuc/PATH2.NC') },
    ],
    { dialect: 'fanuc' }
  );
  const result = alignChannels(prog);
  for (const row of result.rows) {
    assert.equal(row.cells.length, result.channels.length);
  }
});
