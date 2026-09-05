/**
 * G-code lexer — turns one physical line into a flat token stream.
 *
 * Zero dependencies. Dialect-aware only where the *tokenisation* differs
 * (Mitsubishi `!Ln` sync directives, `$n` channel markers). Semantic
 * interpretation happens in {@link gcodeParser}.
 */

import type { Dialect } from '../types';

export type TokenType =
  | 'word' // address letter + number   (G01, X-12.5, F.08)
  | 'comment' // ( … )  or  ; …
  | 'blockDelete' // leading '/'
  | 'channelMarker' // $1 / $PATH2  (single-file multi-channel)
  | 'sync' // Mitsubishi  !L2  /  ! 3
  | 'programNumber' // O1001 / :1001
  | 'macro' // #100 = …  (captured raw, not evaluated)
  | 'unknown';

export interface Token {
  type: TokenType;
  /** Address letter for `word` tokens; directive keyword otherwise. */
  letter: string;
  /** Numeric value (NaN when not applicable / unresolved). */
  value: number;
  raw: string;
  col: number;
}

const ADDRESS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Evaluate a Fanuc-style bracket expression.
 * Supports `+ - * / [ ]` and the functions are intentionally *not* supported;
 * unresolved macro variables (`#n`) yield NaN so callers can flag them.
 */
export function evalExpression(src: string): number {
  const tokens = src.match(/#?\d+\.?\d*|[-+*/()[\]]/g);
  if (!tokens) return NaN;
  // Translate brackets to parens and reject macro variables.
  const normalised = tokens
    .map((t) => (t === '[' ? '(' : t === ']' ? ')' : t))
    .join(' ');
  if (/#/.test(normalised)) return NaN;
  if (!/^[-+*/()\d.\s]+$/.test(normalised)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${normalised});`)();
    return typeof v === 'number' && isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

export function lexLine(line: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  const peek = (o = 0) => line[i + o];

  // Leading whitespace.
  while (i < n && /\s/.test(line[i])) i++;

  // Block delete.
  if (peek() === '/') {
    // `/2` selective block delete keeps the digit as part of the marker.
    let raw = '/';
    i++;
    if (/\d/.test(peek() ?? '')) {
      raw += peek();
      i++;
    }
    tokens.push({ type: 'blockDelete', letter: '/', value: NaN, raw, col: 0 });
    while (i < n && /\s/.test(line[i])) i++;
  }

  while (i < n) {
    const start = i;
    const ch = line[i];

    // Whitespace.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comments: ( … )  — may be unterminated.
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (line[i] === '(') depth++;
        else if (line[i] === ')') depth--;
        i++;
      }
      const raw = line.slice(start, i);
      tokens.push({
        type: 'comment',
        letter: '(',
        value: NaN,
        raw,
        col: start,
      });
      continue;
    }

    // Comments: ; to end of line.
    if (ch === ';') {
      tokens.push({
        type: 'comment',
        letter: ';',
        value: NaN,
        raw: line.slice(i),
        col: start,
      });
      i = n;
      continue;
    }

    // Mitsubishi / Citizen line-up directive:
    //   !L2   ·   !3   ·   !1L2 (system 1 waits at 2)   ·   !12L2 (systems 1&2)
    //   !1!2L2 (multi-system form)
    if (ch === '!') {
      i++;
      const isSyncChar = (c: string | undefined) => c !== undefined && /[0-9Ll!]/.test(c);
      while (i < n) {
        if (isSyncChar(line[i])) {
          i++;
          continue;
        }
        if (line[i] === ' ') {
          let k = i;
          while (k < n && line[k] === ' ') k++;
          if (isSyncChar(line[k])) {
            i = k;
            continue;
          }
        }
        break;
      }
      const raw = line.slice(start, i);
      // Primary wait number: after the last `L`, else the trailing digits.
      const lm = raw.match(/[Ll]\s*(\d+)(?!.*\d)/);
      const tm = raw.match(/(\d+)(?!.*\d)/);
      const value = lm ? parseInt(lm[1], 10) : tm ? parseInt(tm[1], 10) : NaN;
      tokens.push({ type: 'sync', letter: '!', value, raw, col: start });
      continue;
    }

    // Channel marker: $1 .. $4  or  $PATH2
    if (ch === '$') {
      i++;
      let body = '';
      while (i < n && /[A-Za-z0-9_]/.test(line[i])) body += line[i++];
      const m = body.match(/(\d+)/);
      tokens.push({
        type: 'channelMarker',
        letter: '$',
        value: m ? parseInt(m[1], 10) : NaN,
        raw: line.slice(start, i),
        col: start,
      });
      continue;
    }

    // Program number: O1001  or  :1001
    if ((ch === 'O' || ch === 'o' || ch === ':') && /\d/.test(line[i + 1] ?? '')) {
      i++;
      let num = '';
      while (i < n && /[0-9]/.test(line[i])) num += line[i++];
      tokens.push({
        type: 'programNumber',
        letter: 'O',
        value: parseInt(num, 10),
        raw: line.slice(start, i),
        col: start,
      });
      continue;
    }

    // Macro assignment / reference: #100 = …  (captured, not executed)
    if (ch === '#') {
      i++;
      while (i < n && !/\s/.test(line[i])) i++;
      tokens.push({
        type: 'macro',
        letter: '#',
        value: NaN,
        raw: line.slice(start, i),
        col: start,
      });
      continue;
    }

    // Address word: <letter> <number | [expr]>
    const upper = ch.toUpperCase();
    if (ADDRESS_LETTERS.includes(upper)) {
      i++;
      while (i < n && /\s/.test(line[i])) i++;
      let numRaw = '';
      let value = NaN;

      if (line[i] === '[') {
        // Bracket expression.
        let depth = 0;
        const exprStart = i;
        do {
          if (line[i] === '[') depth++;
          else if (line[i] === ']') depth--;
          i++;
        } while (i < n && depth > 0);
        numRaw = line.slice(exprStart, i);
        value = evalExpression(numRaw);
      } else {
        // Plain signed decimal.
        let s = '';
        if (line[i] === '+' || line[i] === '-') s += line[i++];
        while (i < n && /[0-9.]/.test(line[i])) s += line[i++];
        numRaw = s;
        value = s === '' || s === '+' || s === '-' || s === '.' ? NaN : parseFloat(s);
      }

      tokens.push({
        type: 'word',
        letter: upper,
        value,
        raw: line.slice(start, i),
        col: start,
      });
      continue;
    }

    // Anything else — emit a single unknown char so column math stays sane.
    i++;
    tokens.push({
      type: 'unknown',
      letter: ch,
      value: NaN,
      raw: ch,
      col: start,
    });
  }

  void dialect; // reserved for future dialect-specific tokenisation
  return tokens;
}
