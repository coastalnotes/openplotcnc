/**
 * G-code parser — builds a per-channel AST ({@link ChannelProgram}) with a full
 * modal-state snapshot on every block and structured wait/sync tokens.
 *
 * Handles the Fanuc and Mitsubishi turning / Swiss dialects:
 *   - linear & circular motion            G00 G01 G02 G03
 *   - plane select                        G17 G18 G19
 *   - units / distance / feed mode        G20 G21 · G90 G91 · G94 G95
 *   - work offsets                        G54–G59 · G54.1 Pn
 *   - cutter radius / length comp         G40 G41 G42 · G43 G44 G49
 *   - polar / cylindrical interpolation   G12.1 G13.1 · G07.1
 *   - lathe canned cycles                 G71 G72 G73 G74 G75 G76 G70 G90 G92 G94
 *   - sub-spindle / transfer              G30 G140 G141 G142
 *   - dwell                               G04
 */

import type {
  ChannelProgram,
  CannedCycle,
  Diagnostic,
  Dialect,
  GcodeBlock,
  ModalState,
  MotionType,
  MultiChannelProgram,
  Plane,
  Word,
} from '../types';
import { lexLine } from './gcodeLexer';
import { detectSync } from './syncCodes';
import {
  extractSubprograms,
  truncateAtProgramEnd,
  type SplitProgram,
} from './subprograms';

export interface ParseOptions {
  dialect: Dialect;
  defaultPlane?: Plane;
  defaultUnits?: 'mm' | 'inch';
  defaultFeedMode?: 'per-min' | 'per-rev';
}

const CYCLE_KIND: Record<string, CannedCycle['kind']> = {
  G70: 'finish',
  G71: 'rough-turn',
  G72: 'rough-face',
  G73: 'rough-turn',
  G74: 'peck',
  G75: 'groove',
  G76: 'thread',
  G90: 'simple',
  G92: 'thread',
  G94: 'simple',
};

function freshModal(opts: ParseOptions): ModalState {
  return {
    motion: 'none',
    plane: opts.defaultPlane ?? 'ZX',
    units: opts.defaultUnits ?? 'mm',
    distance: 'abs',
    arcDistance: 'inc',
    feedMode: opts.defaultFeedMode ?? 'per-min',
    wcs: 'G54',
    cutterComp: 'off',
    lengthComp: 'off',
    toolOffset: 0,
    tool: '',
    spindleMode: 'rpm',
    spindleOn: false,
    spindleCw: true,
    coolant: false,
    transform: 'none',
    cylinderRadius: 0,
  };
}

function gword(words: Word[], target: number): boolean {
  return words.some(
    (w) => w.letter === 'G' && Math.abs(w.value - target) < 1e-6
  );
}

/** All G-code values on the block, rounded for switch matching. */
function gcodes(words: Word[]): number[] {
  return words.filter((w) => w.letter === 'G').map((w) => w.value);
}

function diag(
  severity: Diagnostic['severity'],
  message: string,
  line: number,
  col: number,
  length: number
): Diagnostic {
  return { severity, message, line, col, length };
}

/**
 * Split a single physical file into per-channel sources using section markers
 * (`$1`..`$4`, `O1001`..`O1004`, or custom). Returns a map keyed by channel id.
 * If no markers are found the whole file is returned as channel 1.
 */
export function splitChannels(
  text: string,
  markers: string[]
): Map<number, string> {
  const lines = text.split(/\r?\n/);
  const result = new Map<number, string[]>();

  // Native `$1`..`$4` section markers, plus any configured aliases
  // (e.g. `O1001`..`O1004`) mapped to channels by their position in the list.
  const aliasMatchers = markers
    .filter((m) => !/^\$\d/.test(m))
    .map((m, idx) => ({
      channel: idx + 1,
      re: new RegExp('^\\s*' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'),
    }));

  // `$0` (and `$5`+) is a common / variable / offset section on Citizen-style
  // controls — not a tool channel. It is routed to a sink (-1), kept out of the
  // channel list but preserved for write-back via the trailer.
  const COMMON = -1;
  const markerChannel = (line: string): number | undefined => {
    const native = line.match(/^\s*\$\s*(\d{1,2})\b/);
    if (native) {
      const n = parseInt(native[1], 10);
      return n >= 1 && n <= 4 ? n : COMMON;
    }
    const alias = aliasMatchers.find((mm) => mm.re.test(line));
    return alias?.channel;
  };

  let current = 0;
  let sawMarker = false;
  let sawChannel = false;
  const preamble: string[] = [];
  const common: string[] = [];

  for (const line of lines) {
    const ch = markerChannel(line);
    if (ch !== undefined) {
      current = ch;
      sawMarker = true;
      if (ch >= 1) {
        sawChannel = true;
        if (!result.has(current)) result.set(current, []);
      }
      continue; // the marker line itself is not program content
    }
    if (current === COMMON) {
      common.push(line);
      continue;
    }
    if (current === 0) {
      preamble.push(line); // content before the first `$n`
      continue;
    }
    if (!result.has(current)) result.set(current, []);
    result.get(current)!.push(line);
  }

  void sawMarker;
  // A file with only `$0` (no real channels) is a plain single program.
  if (!sawChannel) {
    return new Map([[1, text]]);
  }

  // Attach any preamble (program number, safe-start block, header comments)
  // to the lowest-numbered channel.
  const firstChannel = Math.min(...result.keys());
  if (preamble.some((l) => l.trim() !== '')) {
    const body = result.get(firstChannel) ?? [];
    result.set(firstChannel, [...preamble, ...body]);
  }

  const out = new Map<number, string>();
  for (const [ch, ls] of [...result.entries()].sort((a, b) => a[0] - b[0])) {
    out.set(ch, ls.join('\n'));
  }
  if (common.some((l) => l.trim() !== '')) out.set(COMMON, common.join('\n'));
  return out;
}

/**
 * Full single-file split: channels cut at their program-end word
 * (`M99` on some controls, `M30`/`M02` on others) plus a pool of `O#### … M99`
 * subprograms collected from the trailing area (never from channel bodies).
 */
export function splitProgram(text: string, markers: string[]): SplitProgram {
  const raw = splitChannels(text, markers);
  const channels = new Map<number, string>();
  const tails: string[] = [];

  // `$0` common / variable section (key -1) is kept aside for write-back only.
  const commonSection = raw.get(-1) ?? '';
  raw.delete(-1);

  for (const [id, src] of raw) {
    const { body, tail } = truncateAtProgramEnd(src);
    channels.set(id, body);
    if (tail.trim() !== '') tails.push(tail);
  }
  if (commonSection.trim() !== '') tails.push(`$0\n${commonSection}`);

  // Subprograms live in the tail(s); fall back to the whole file only if the
  // tails held nothing (some posts drop subprograms before the first `$n`).
  const trailer = tails.join('\n').replace(/^\s+|\s+$/g, '');
  let subprograms = extractSubprograms(trailer);
  if (subprograms.size === 0 && raw.size <= 1) {
    subprograms = extractSubprograms(text);
  }

  return { channels, subprograms, trailer };
}

export function parseChannel(
  source: string,
  channel: number,
  name: string,
  opts: ParseOptions,
  uri?: string
): ChannelProgram {
  const lines = source.split(/\r?\n/);
  const blocks: GcodeBlock[] = [];
  const channelDiags: Diagnostic[] = [];
  const modal = freshModal(opts);
  let feed: number | undefined;
  let spindleSpeed: number | undefined;
  let programNumber: number | undefined;

  lines.forEach((rawLine, sourceLine) => {
    const tokens = lexLine(rawLine, opts.dialect);
    if (tokens.length === 0) return;

    const diagnostics: Diagnostic[] = [];
    const words: Word[] = [];
    let comment: string | undefined;
    let blockDelete = false;
    let channelMarker: number | undefined;
    let syncLex: { value: number; raw: string } | undefined;
    let blockProgramNumber: number | undefined;
    let nNumber: number | undefined;

    for (const t of tokens) {
      switch (t.type) {
        case 'blockDelete':
          blockDelete = true;
          break;
        case 'comment':
          comment = (comment ? comment + ' ' : '') + stripComment(t.raw);
          if (t.letter === '(' && !t.raw.endsWith(')')) {
            diagnostics.push(
              diag('warning', 'Unterminated comment', sourceLine, t.col, t.raw.length)
            );
          }
          break;
        case 'channelMarker':
          channelMarker = t.value;
          break;
        case 'sync':
          syncLex = { value: t.value, raw: t.raw };
          if (Number.isNaN(t.value)) {
            diagnostics.push(
              diag('warning', 'Sync directive without a number', sourceLine, t.col, t.raw.length)
            );
          }
          break;
        case 'programNumber':
          blockProgramNumber = t.value;
          programNumber = t.value;
          break;
        case 'macro':
          // Captured but not executed.
          break;
        case 'word': {
          const w: Word = { letter: t.letter, value: t.value, raw: t.raw, col: t.col };
          if (t.letter === 'N' && Number.isFinite(t.value)) {
            nNumber = t.value;
          } else {
            words.push(w);
          }
          if (Number.isNaN(t.value) && t.raw.includes('[')) {
            diagnostics.push(
              diag(
                'info',
                `Unresolved expression in ${t.letter} (macro variables not evaluated)`,
                sourceLine,
                t.col,
                t.raw.length
              )
            );
          }
          break;
        }
        case 'unknown':
          if (!/\s/.test(t.raw) && t.raw !== '%') {
            diagnostics.push(
              diag('warning', `Unexpected character '${t.raw}'`, sourceLine, t.col, 1)
            );
          }
          break;
      }
    }

    // A bare channel-marker line carries no executable content.
    if (channelMarker !== undefined && words.length === 0 && !comment) {
      return;
    }

    // ---- modal updates -------------------------------------------------
    applyModal(modal, words, opts, sourceLine, diagnostics);

    // ---- feed / speed -------------------------------------------------
    const fWord = words.find((w) => w.letter === 'F');
    if (fWord && Number.isFinite(fWord.value)) feed = fWord.value;
    const sWord = words.find((w) => w.letter === 'S');
    if (sWord && Number.isFinite(sWord.value)) spindleSpeed = sWord.value;

    // ---- motion -----------------------------------------------------
    const motion = resolveMotion(words, modal);
    modal.motion = motion === 'dwell' || motion === 'none' ? modal.motion : motion;

    // ---- coordinates ---------------------------------------------------
    const coords: GcodeBlock['coords'] = {};
    for (const w of words) {
      if ('XYZUVWCAB'.includes(w.letter) && Number.isFinite(w.value)) {
        (coords as any)[w.letter] = w.value;
      }
    }
    let arc: GcodeBlock['arc'] | undefined;
    for (const w of words) {
      if ('IJKR'.includes(w.letter) && Number.isFinite(w.value)) {
        arc = arc ?? {};
        (arc as any)[w.letter.toLowerCase()] = w.value;
      }
    }
    if ((motion === 'arc-cw' || motion === 'arc-ccw') && !arc) {
      diagnostics.push(
        diag('error', 'Arc move without I/J/K offset or R radius', sourceLine, 0, rawLine.length)
      );
    }

    // ---- dwell -------------------------------------------------------
    let dwellSec: number | undefined;
    if (motion === 'dwell') {
      const p = words.find((w) => w.letter === 'P');
      const x = words.find((w) => w.letter === 'X' || w.letter === 'U');
      if (p && Number.isFinite(p.value)) dwellSec = p.value / 1000;
      else if (x && Number.isFinite(x.value)) dwellSec = x.value;
    }

    // ---- canned cycles ---------------------------------------------
    const cycle = resolveCannedCycle(words, blocks.length);

    // ---- sync ------------------------------------------------------
    const sync = detectSync(rawLine, words, syncLex, opts.dialect);

    const block: GcodeBlock = {
      channel,
      index: blocks.length,
      sourceLine,
      raw: rawLine,
      blockDelete,
      words,
      comment,
      programNumber: blockProgramNumber,
      n: nNumber,
      motion,
      coords,
      arc,
      feed: feed,
      spindleSpeed: spindleSpeed,
      dwellSec,
      sync,
      cycle,
      modal: { ...modal },
      diagnostics,
    };

    blocks.push(block);
    channelDiags.push(...diagnostics);
  });

  void programNumber;
  return { channel, name, source, uri, blocks, diagnostics: channelDiags };
}

export function parseMultiChannel(
  inputs: { channel: number; name: string; source: string; uri?: string }[],
  opts: ParseOptions
): MultiChannelProgram {
  return {
    dialect: opts.dialect,
    channels: inputs
      .sort((a, b) => a.channel - b.channel)
      .map((c) => parseChannel(c.source, c.channel, c.name, opts, c.uri)),
  };
}

/* ------------------------------------------------------------------ *
 *  Internals
 * ------------------------------------------------------------------ */

function stripComment(raw: string): string {
  if (raw.startsWith('(')) return raw.replace(/^\(/, '').replace(/\)$/, '').trim();
  return raw.replace(/^;/, '').trim();
}

function applyModal(
  modal: ModalState,
  words: Word[],
  opts: ParseOptions,
  line: number,
  diagnostics: Diagnostic[]
): void {
  const gs = gcodes(words);

  for (const g of gs) {
    switch (true) {
      // plane
      case near(g, 17):
        modal.plane = 'XY';
        break;
      case near(g, 18):
        modal.plane = 'ZX';
        break;
      case near(g, 19):
        modal.plane = 'YZ';
        break;
      // units
      case near(g, 20):
        modal.units = 'inch';
        break;
      case near(g, 21):
        modal.units = 'mm';
        break;
      // distance
      case near(g, 90):
        modal.distance = 'abs';
        break;
      case near(g, 91):
        modal.distance = 'inc';
        break;
      case near(g, 90.1):
        modal.arcDistance = 'abs';
        break;
      case near(g, 91.1):
        modal.arcDistance = 'inc';
        break;
      // feed mode  (G94 per-min, G95 per-rev, G93 inverse-time)
      case near(g, 93):
        modal.feedMode = 'per-min';
        break;
      case near(g, 94):
        modal.feedMode = 'per-min';
        break;
      case near(g, 95):
        modal.feedMode = 'per-rev';
        break;
      case near(g, 98) && opts.dialect !== 'mitsubishi':
        modal.feedMode = 'per-min';
        break;
      case near(g, 99) && opts.dialect !== 'mitsubishi':
        modal.feedMode = 'per-rev';
        break;
      // spindle mode
      case near(g, 96):
        modal.spindleMode = 'css';
        break;
      case near(g, 97):
        modal.spindleMode = 'rpm';
        break;
      // work offsets
      case near(g, 54):
      case near(g, 55):
      case near(g, 56):
      case near(g, 57):
      case near(g, 58):
      case near(g, 59):
        modal.wcs = `G${Math.round(g)}`;
        break;
      case near(g, 54.1): {
        const p = words.find((w) => w.letter === 'P');
        modal.wcs = `G54.1P${p ? Math.round(p.value) : 1}`;
        break;
      }
      // cutter radius comp
      case near(g, 40):
        modal.cutterComp = 'off';
        break;
      case near(g, 41):
        modal.cutterComp = 'left';
        break;
      case near(g, 42):
        modal.cutterComp = 'right';
        break;
      // length comp
      case near(g, 43):
        modal.lengthComp = 'positive';
        break;
      case near(g, 44):
        modal.lengthComp = 'negative';
        break;
      case near(g, 49):
        modal.lengthComp = 'off';
        break;
      // polar / cylindrical interpolation
      case near(g, 12.1):
      case near(g, 112):
        modal.transform = 'polar';
        break;
      case near(g, 13.1):
      case near(g, 113):
        modal.transform = 'none';
        break;
      case near(g, 7.1):
      case near(g, 107): {
        const c = words.find((w) => w.letter === 'C' || w.letter === 'Q');
        if (c && Math.abs(c.value) > 1e-6) {
          modal.transform = 'cylindrical';
          modal.cylinderRadius = Math.abs(c.value);
        } else {
          modal.transform = 'none';
        }
        break;
      }
      default:
        break;
    }
  }

  // Tool word (Fanuc lathe: T0101 → geometry 01, offset 01).
  const t = words.find((w) => w.letter === 'T');
  if (t && Number.isFinite(t.value)) {
    modal.tool = `T${t.raw.replace(/^T/i, '')}`;
    const digits = t.raw.replace(/[^0-9]/g, '');
    if (digits.length >= 3) {
      modal.toolOffset = parseInt(digits.slice(-2), 10);
    }
  }

  // Spindle / coolant M-codes.
  for (const w of words) {
    if (w.letter !== 'M') continue;
    const m = Math.round(w.value);
    if (m === 3) {
      modal.spindleOn = true;
      modal.spindleCw = true;
    } else if (m === 4) {
      modal.spindleOn = true;
      modal.spindleCw = false;
    } else if (m === 5) {
      modal.spindleOn = false;
    } else if (m === 7 || m === 8) {
      modal.coolant = true;
    } else if (m === 9) {
      modal.coolant = false;
    }
  }

  void line;
  void diagnostics;
}

function resolveMotion(words: Word[], modal: ModalState): MotionType {
  if (gword(words, 4)) return 'dwell';
  if (gword(words, 0)) return 'rapid';
  if (gword(words, 1)) return 'linear';
  if (gword(words, 2)) return 'arc-cw';
  if (gword(words, 3)) return 'arc-ccw';

  const hasAxis = words.some((w) => 'XYZUVWCAB'.includes(w.letter) && Number.isFinite(w.value));
  if (hasAxis) {
    // Modal motion continues, but a canned cycle "eats" the axis words.
    if (words.some((w) => w.letter === 'G' && isCannedCycleCode(w.value))) return 'none';
    return modal.motion === 'none' ? 'linear' : modal.motion;
  }
  return 'none';
}

function isCannedCycleCode(g: number): boolean {
  return [70, 71, 72, 73, 74, 75, 76, 90, 92, 94].some((c) => near(g, c));
}

function resolveCannedCycle(words: Word[], blockIndex: number): CannedCycle | undefined {
  const g = words.find((w) => w.letter === 'G' && isCannedCycleCode(w.value));
  if (!g) return undefined;
  const code = `G${Math.round(g.value)}`;
  const params: Record<string, number> = {};
  for (const w of words) {
    if ('PQUWRDIKFAE'.includes(w.letter) && Number.isFinite(w.value)) {
      params[w.letter] = w.value;
    }
  }
  const kind = CYCLE_KIND[code] ?? 'simple';
  const cycle: CannedCycle = { code, kind, params };
  if (code === 'G70' || code === 'G71' || code === 'G72' || code === 'G73') {
    // P and Q address the first/last block of the finishing profile.
    if (Number.isFinite(params.P) && Number.isFinite(params.Q)) {
      cycle.profileRange = [params.P, params.Q];
    }
  }
  void blockIndex;
  return cycle;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
