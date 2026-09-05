/**
 * Wait / rendezvous code detection for multi-channel programs.
 *
 * Fanuc multipath:
 *   - `M100`..`M199`                 simple rendezvous (all channels sharing the code)
 *   - `M<code> P<mask>`              wait only on the channels in the P bitmask
 *   - `WAITCODE <n>` / `WAIT <n>`    macro alias some post-processors emit
 *
 * Mitsubishi multipath:
 *   - `!L1`..`!Ln`  /  `! n`         line-up / wait code
 *   - `M100`                         also treated as a rendezvous barrier
 */

import type { Dialect, SyncToken, Word } from '../types';

/** Decode a Fanuc path bitmask (`P3` → channels 1 & 2). */
export function decodePathMask(mask: number): number[] {
  if (!isFinite(mask) || mask <= 0) return [];
  const out: number[] = [];
  const bits = Math.round(mask);
  for (let ch = 1; ch <= 4; ch++) {
    if (bits & (1 << (ch - 1))) out.push(ch);
  }
  return out;
}

export function detectSync(
  raw: string,
  words: Word[],
  syncValueFromLexer: number | undefined,
  dialect: Dialect
): SyncToken | undefined {
  // Mitsubishi `!Ln` — surfaced by the lexer as a dedicated token.
  if (syncValueFromLexer !== undefined && !Number.isNaN(syncValueFromLexer)) {
    return {
      kind: 'mitsubishi-L',
      id: syncValueFromLexer,
      partners: [],
      raw: raw.trim(),
    };
  }

  // WAITCODE / WAIT alias.
  const waitAlias = raw.match(/\bWAIT(?:CODE)?\s*[:=]?\s*(\d+)/i);
  if (waitAlias) {
    const p = words.find((w) => w.letter === 'P');
    return {
      kind: 'fanuc-waitcode',
      id: parseInt(waitAlias[1], 10),
      partners: p ? decodePathMask(p.value) : [],
      raw: raw.trim(),
    };
  }

  const mWords = words.filter((w) => w.letter === 'M' && Number.isFinite(w.value));

  for (const m of mWords) {
    const code = Math.round(m.value);

    if (dialect === 'fanuc' && code >= 100 && code <= 199) {
      const p = words.find((w) => w.letter === 'P');
      const partners = p ? decodePathMask(p.value) : [];
      return {
        kind: partners.length ? 'fanuc-pwait' : 'fanuc-mwait',
        id: code,
        partners,
        raw: raw.trim(),
      };
    }

    if (dialect === 'mitsubishi' && code === 100) {
      return {
        kind: 'mitsubishi-L',
        id: 100,
        partners: [],
        raw: raw.trim(),
      };
    }
  }

  return undefined;
}

/** True when the M-code is *only* a rendezvous and carries no machine action. */
export function isPureSyncCode(code: number, dialect: Dialect): boolean {
  if (dialect === 'fanuc') return code >= 100 && code <= 199;
  return code === 100;
}
