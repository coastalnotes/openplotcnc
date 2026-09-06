import { reviewProgram, type Finding } from '../../src/validate/review';
import { alignChannels } from '../../src/channels/alignment';
import { parseMultiChannel } from '../../src/parser';
import type { Dialect } from '../../src/types';

export interface ReviewSource {
  channel: number;
  name: string;
  source: string;
}

const ICON: Record<Finding['severity'], string> = { error: '⛔', warning: '⚠', info: 'ⓘ' };

/** The Channels-pane review drawer: syntax problems + sync-code check. */
export class ReviewPanel {
  private lastCount = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly onJump: (channel: number, line: number) => void
  ) {
    host.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-ch]') as HTMLElement | null;
      if (row) this.onJump(Number(row.dataset.ch), Number(row.dataset.line));
    });
  }

  get visible(): boolean {
    return !this.host.hidden;
  }

  /** Count of error+warning findings from the last render. */
  get issueCount(): number {
    return this.lastCount;
  }

  hide(): void {
    this.host.hidden = true;
  }

  toggle(sources: ReviewSource[], dialect: Dialect): void {
    if (!this.host.hidden) {
      this.host.hidden = true;
      return;
    }
    this.render(sources, dialect);
    this.host.hidden = false;
  }

  /** Re-render if already open (after an edit) and return the issue count. */
  refresh(sources: ReviewSource[], dialect: Dialect): number {
    const program = parseMultiChannel(sources, { dialect });
    const review = reviewProgram(program);
    this.lastCount = review.errors + review.warnings;
    if (!this.host.hidden) this.paint(sources, dialect);
    return this.lastCount;
  }

  private render(sources: ReviewSource[], dialect: Dialect): void {
    this.paint(sources, dialect);
  }

  private paint(sources: ReviewSource[], dialect: Dialect): void {
    const program = parseMultiChannel(sources, { dialect });
    const review = reviewProgram(program);
    this.lastCount = review.errors + review.warnings;
    const align = alignChannels(program);

    const summary =
      review.errors + review.warnings + review.infos === 0
        ? `<div class="rv-clean">✓ No problems found</div>`
        : `<div class="rv-summary">` +
          `<span class="rv-e">${review.errors} error${review.errors === 1 ? '' : 's'}</span>` +
          `<span class="rv-w">${review.warnings} warning${review.warnings === 1 ? '' : 's'}</span>` +
          `<span class="rv-i">${review.infos} info</span>` +
          `</div>`;

    const problemRows = review.findings
      .map(
        (f) => `<div class="rv-row ${f.severity}" data-ch="${f.channel}" data-line="${f.line}">
          <span class="rv-ico">${ICON[f.severity]}</span>
          <span class="rv-loc">${esc(f.channelName)}·L${f.line + 1}</span>
          <span class="rv-msg">${esc(f.message)}</span>
          <span class="rv-cat">${f.category}</span>
        </div>`
      )
      .join('');

    const barrierRows = align.barriers.length
      ? align.barriers
          .map((b) => {
            const parts = [...b.participants.entries()]
              .map(([ch, ln]) => `CH${ch}·L${ln + 1}`)
              .join('  ');
            const first = [...b.participants.entries()][0] ?? [0, 0];
            return `<div class="rv-row ${b.matched ? 'ok' : 'warning'}" data-ch="${first[0]}" data-line="${first[1]}">
              <span class="rv-ico">${b.matched ? '⇄' : '⚠'}</span>
              <span class="rv-loc">${esc(b.raw || String(b.id))}</span>
              <span class="rv-msg">${esc(parts)}</span>
              <span class="rv-cat">${b.matched ? 'aligned' : 'unmatched'}</span>
            </div>`;
          })
          .join('')
      : `<div class="rv-clean">No wait / sync codes across channels</div>`;

    this.host.innerHTML = `
      ${summary}
      <div class="rv-section">Problems</div>
      ${problemRows || '<div class="rv-clean">Nothing flagged</div>'}
      <div class="rv-section">Sync points</div>
      ${barrierRows}`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
