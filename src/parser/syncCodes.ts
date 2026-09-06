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
 *
 * Citizen Cincom (Mitsubishi-Meldas based, `$1`..`$3` tool systems):
 *   - `!<systems>L<n>`               line-up: `!1L2`, `!12L2` (sys 1+2), `!1!2L2`
 *   - `!Ln` / `!n`                   line-up without an explicit system list
 *   - `M6xx` (M600..M699)            queue / waiting M-code sequence
 *   - `G6xx` (G600..G699)            queue / waiting G-code sequence (e.g. G600, G630)
 *   - `G9xx` (G900..G999)            end / cycle sequence codes (e.g. G999 "one cycle")
 *
 * Note: on Citizen, `M100`..`M199` are machine functions (M162 part-ejector,
 * M163 spot spindle, …), NOT waiting codes — only Fanuc treats that range as
 * rendezvous.
 */

/** G-sync ids are offset so they never collide with M-code ids. */
const G_SYNC_OFFSET = 1000;

/** A Citizen G-code that acts as a queue / line-up / sequence rendezvous. */
export function isCitizenSyncGCode(code: number): boolean {
  return (code >= 600 && code <= 699) || (code >= 900 && code <= 999);
}

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

/** Parse a Citizen / Mitsubishi `!` line-up directive into id + participants. */
export function parseLineup(raw: string): { id: number; partners: number[] } | undefined {
  if (!raw.includes('!')) return undefined;
  const partners = new Set<number>();
  let id: number;

  if (/[Ll]/.test(raw)) {
    const l = raw.match(/[Ll]\s*(\d+)/);
    id = l ? parseInt(l[1], 10) : NaN;
    for (const g of raw.matchAll(/!\s*(\d+)/g)) {
      for (const c of g[1]) {
        const s = Number(c);
        if (s >= 1 && s <= 4) partners.add(s);
      }
    }
  } else {
    const num = raw.match(/(\d+)/);
    id = num ? parseInt(num[1], 10) : NaN;
  }
  if (Number.isNaN(id)) return undefined;
  return { id, partners: [...partners].sort() };
}

export function detectSync(
  raw: string,
  words: Word[],
  syncFromLexer: { value: number; raw: string } | undefined,
  dialect: Dialect
): SyncToken | undefined {
  // `!` line-up directive — surfaced by the lexer as a dedicated token.
  if (syncFromLexer) {
    const parsed = parseLineup(syncFromLexer.raw);
    if (parsed) {
      return {
        kind: 'mitsubishi-L',
        id: parsed.id,
        partners: parsed.partners,
        raw: syncFromLexer.raw.trim(),
      };
    }
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

  // Citizen queue / line-up / end-sequence G-codes (G600, G630, G999, …).
  if (dialect === 'citizen') {
    const g = words.find(
      (w) => w.letter === 'G' && Number.isFinite(w.value) && isCitizenSyncGCode(w.value)
    );
    if (g) {
      const code = Math.round(g.value);
      return { kind: 'fanuc-mwait', id: G_SYNC_OFFSET + code, partners: [], raw: `G${code}` };
    }
  }

  const mWords = words.filter((w) => w.letter === 'M' && Number.isFinite(w.value));

  for (const m of mWords) {
    const code = Math.round(m.value);

    // Citizen M6xx queue / waiting sequence.
    if (dialect === 'citizen' && code >= 600 && code <= 699) {
      return { kind: 'fanuc-mwait', id: code, partners: [], raw: `M${code}` };
    }

    // Fanuc M1xx rendezvous.  (NOT Citizen — there M1xx are machine-function
    // codes like M162 part-ejector / M163 spot spindle, not waiting codes.)
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
      return { kind: 'mitsubishi-L', id: 100, partners: [], raw: raw.trim() };
    }
  }

  return undefined;
}

/** True when the M-code is *only* a rendezvous and carries no machine action. */
export function isPureSyncCode(code: number, dialect: Dialect): boolean {
  if (dialect === 'fanuc') return code >= 100 && code <= 199;
  if (dialect === 'citizen') return code >= 600 && code <= 699;
  return code === 100;
}


/** Human label for a sync id (undoes the G6xx id offset). */
export function syncIdLabel(id: number): string {
  return id > G_SYNC_OFFSET ? `G${id - G_SYNC_OFFSET}` : `M${id}`;
}
