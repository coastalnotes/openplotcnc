/**
 * Ribbon-bar chrome for the backplotter webview.
 *
 * Grouped, labelled, large-target buttons (Office-style). Emits semantic
 * actions through a single callback so `main.ts` stays the orchestrator.
 */

export type RibbonAction =
  | 'reload'
  | 'backplot'
  | 'clear'
  | 'play'
  | 'rewind'
  | 'stepBack'
  | 'stepFwd'
  | 'view-fit'
  | 'view-iso'
  | 'view-top'
  | 'view-front'
  | 'toggle-rapids'
  | 'toggle-grid'
  | 'setup';

interface RibbonButton {
  action: RibbonAction;
  label: string;
  glyph: string;
  primary?: boolean;
  toggle?: boolean;
}

interface RibbonGroup {
  title: string;
  buttons: RibbonButton[];
}

const GROUPS: RibbonGroup[] = [
  {
    title: 'Program',
    buttons: [{ action: 'reload', label: 'Reload\nFile', glyph: '⟳' }],
  },
  {
    title: 'Backplot',
    buttons: [
      { action: 'backplot', label: 'Run\nBackplot', glyph: '▤', primary: true },
      { action: 'clear', label: 'Clear', glyph: '⌫' },
    ],
  },
  {
    title: 'Playback',
    buttons: [
      { action: 'rewind', label: 'Rewind', glyph: '⏮' },
      { action: 'play', label: 'Play', glyph: '▶' },
      { action: 'stepBack', label: 'Step\nBack', glyph: '◄' },
      { action: 'stepFwd', label: 'Step\nFwd', glyph: '►' },
    ],
  },
  {
    title: 'View',
    buttons: [
      { action: 'view-fit', label: 'Fit', glyph: '⤢' },
      { action: 'view-iso', label: 'Iso', glyph: '◈' },
      { action: 'view-top', label: 'Top', glyph: '▦' },
      { action: 'view-front', label: 'Front', glyph: '◭' },
      { action: 'toggle-rapids', label: 'Rapids', glyph: '⇢', toggle: true },
      { action: 'toggle-grid', label: 'Grid', glyph: '▩', toggle: true },
    ],
  },
  {
    title: 'Setup',
    buttons: [{ action: 'setup', label: 'Machine &\nTooling', glyph: '⚙' }],
  },
];

export class Ribbon {
  private readonly playBtn: HTMLButtonElement;
  private readonly toggles = new Map<RibbonAction, boolean>([
    ['toggle-rapids', true],
    ['toggle-grid', true],
  ]);

  constructor(
    private readonly host: HTMLElement,
    private readonly onAction: (a: RibbonAction) => void
  ) {
    host.className = 'ribbon';
    host.innerHTML = `
      <div class="ribbon-brand">
        <span class="ribbon-title">OpenPlotCNC</span>
        <span class="ribbon-sub" data-role="mode"></span>
      </div>
      ${GROUPS.map(
        (g) => `
        <div class="ribbon-group">
          <div class="ribbon-btns">
            ${g.buttons
              .map(
                (b) => `
              <button class="ribbon-btn${b.primary ? ' primary' : ''}${
                  b.toggle ? ' toggle on' : ''
                }" data-action="${b.action}" title="${b.label.replace(/\n/g, ' ')}">
                <span class="ribbon-glyph">${b.glyph}</span>
                <span class="ribbon-label">${b.label.replace(/\n/g, '<br>')}</span>
              </button>`
              )
              .join('')}
          </div>
          <div class="ribbon-group-title">${g.title}</div>
        </div>`
      ).join('')}
    `;

    this.playBtn = host.querySelector('[data-action="play"]') as HTMLButtonElement;

    host.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button.ribbon-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.dataset.action as RibbonAction;
      if (this.toggles.has(action)) {
        const next = !this.toggles.get(action);
        this.toggles.set(action, next);
        btn.classList.toggle('on', next);
      }
      this.onAction(action);
    });
  }

  setMode(text: string): void {
    const el = this.host.querySelector('[data-role="mode"]');
    if (el) el.textContent = text;
  }

  setPlaying(playing: boolean): void {
    this.playBtn.querySelector('.ribbon-glyph')!.textContent = playing ? '⏸' : '▶';
    this.playBtn.querySelector('.ribbon-label')!.textContent = playing ? 'Pause' : 'Play';
  }

  setBackplotActive(active: boolean): void {
    for (const a of ['play', 'rewind', 'stepBack', 'stepFwd', 'clear'] as RibbonAction[]) {
      const b = this.host.querySelector(`[data-action="${a}"]`) as HTMLButtonElement;
      if (b) b.disabled = !active;
    }
    const run = this.host.querySelector('[data-action="backplot"]') as HTMLButtonElement;
    run?.classList.toggle('active', active);
  }

  isOn(action: RibbonAction): boolean {
    return this.toggles.get(action) ?? false;
  }
}
