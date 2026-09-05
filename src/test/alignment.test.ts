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
