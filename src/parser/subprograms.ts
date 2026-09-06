/**
 * Subprogram + program-end handling for single-file programs.
 *
 * Citizen / Cincom / Fanuc single-file programs pack several channel programs
 * (and their subprograms) into one `.PRG`/`.NC`. A channel section ends with a
 * program-end word — `M99` on some controls, `M30` / `M02` on others — and is
 * then followed by the next `$n` marker or by `O#### … M99` subprograms that
 * `M98 P#### [L#]` pulls in.
 */

/** Machine code with `( … )` and `; …` comments removed, for keyword matching. */
function codeOnly(line: string): string {
  return line.replace(/\([^)]*\)/g, ' ').replace(/;.*/, ' ');
}

const END_RE = /(?:^|[^0-9A-Za-z])M0*(?:30|2|02|99)(?![0-9])/;
const RETURN_RE = /(?:^|[^0-9A-Za-z])M0*99(?![0-9])/;
const HARD_END_RE = /(?:^|[^0-9A-Za-z])M0*(?:30|2|02)(?![0-9])/;
const O_RE = /^\s*[O:](\d{1,8})\b/;
const CHANNEL_MARKER_RE = /^\s*\$\s*\d/;

export function isProgramEnd(line: string): boolean {
  return END_RE.test(codeOnly(line));
}

/** Index of the first program-end line (`M99`/`M30`/`M02`), or -1. */
export function findProgramEndLine(source: string): number {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (END_RE.test(codeOnly(lines[i]))) return i;
  }
  return -1;
}

/** Split a channel slice into its body (through the first program-end) + tail. */
export function truncateAtProgramEnd(source: string): { body: string; tail: string } {
  const lines = source.split(/\r?\n/);
  const end = findProgramEndLine(source);
  if (end < 0) return { body: source, tail: '' };
  return {
    body: lines.slice(0, end + 1).join('\n'),
    tail: lines.slice(end + 1).join('\n'),
  };
}

/**
 * Collect `O#### … M99` subprogram blocks. A block only counts as a subprogram
 * when it reaches `M99` before hitting a channel marker, `M30`/`M02`, another
 * `O####`, or end-of-file.
 */
export function extractSubprograms(text: string): Map<number, string> {
  const lines = text.split(/\r?\n/);
  const subs = new Map<number, string>();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(O_RE);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const body: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const code = codeOnly(lines[j]);
      if (CHANNEL_MARKER_RE.test(lines[j]) || O_RE.test(lines[j]) || HARD_END_RE.test(code)) break;
      if (RETURN_RE.test(code)) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    if (closed && !subs.has(num)) subs.set(num, body.join('\n'));
  }
  return subs;
}

export interface SplitProgram {
  /** channel id -> body truncated at its program-end word. */
  channels: Map<number, string>;
  /** O-number -> subprogram body (from the trailing area, not channel bodies). */
  subprograms: Map<number, string>;
  /** Everything the split moved out of channel bodies (subprograms, footer). */
  trailer: string;
  /** channel id -> (channel-line index -> 0-based line in the original file). */
  sourceLineMap: Map<number, number[]>;
}

interface ExpandOptions {
  maxDepth: number;
  maxLines: number;
}

const DEFAULT_EXPAND: ExpandOptions = { maxDepth: 10, maxLines: 200_000 };

function parseCall(line: string): { program: number; repeats: number } | undefined {
  const code = codeOnly(line);
  if (!/(?:^|[^0-9A-Za-z])M0*98(?![0-9])/.test(code)) return undefined;
  const p = code.match(/\bP\s*(\d{1,8})/i);
  const l = code.match(/\bL\s*(\d{1,4})/i);
  const h = code.match(/\bH\s*(\d{1,8})/i);
  let program: number;
  let repeats = l ? parseInt(l[1], 10) : 1;
  if (p) {
    const digits = p[1];
    if (!l && digits.length > 4) {
      program = parseInt(digits.slice(-4), 10);
      repeats = parseInt(digits.slice(0, -4), 10) || 1;
    } else {
      program = parseInt(digits, 10);
    }
  } else if (h) {
    program = parseInt(h[1], 10);
  } else {
    return undefined;
  }
  return { program, repeats: Math.max(1, Math.min(repeats, 999)) };
}

/**
 * Inline `M98` subprogram calls for backplotting. Unknown programs are left
 * as-is (they may live in a sibling file). Depth and total size are bounded.
 */
export function expandSubprograms(
  source: string,
  subs: Map<number, string>,
  options: Partial<ExpandOptions> = {}
): string {
  if (subs.size === 0) return source;
  const opts = { ...DEFAULT_EXPAND, ...options };
  const out: string[] = [];

  const emit = (text: string, depth: number, stack: number[]): void => {
    for (const line of text.split(/\r?\n/)) {
      if (out.length > opts.maxLines) return;
      const call = parseCall(line);
      if (call && subs.has(call.program) && depth < opts.maxDepth && !stack.includes(call.program)) {
        out.push(`(>>> M98 P${call.program}${call.repeats > 1 ? ` x${call.repeats}` : ''})`);
        for (let r = 0; r < call.repeats; r++) emit(subs.get(call.program)!, depth + 1, [...stack, call.program]);
        out.push(`(<<< P${call.program})`);
      } else {
        out.push(line);
      }
    }
  };

  emit(source, 0, []);
  return out.join('\n');
}
