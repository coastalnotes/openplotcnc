/**
 * Fusion 360-style tabbed ribbon.
 *
 *   ┌ tabs ─────────────────────────────────────────────┐
 *   │  HOME   SIMULATE   VIEW   SETUP                    │
 *   ├───────────────────────────────────────────────────┤
 *   │ [ Open ] [ Run ] │ [◀][▶][▶I] │ [Fit][Iso] │ …    │
 *   │  Program   Backplot   Playback      Camera         │
 *   └───────────────────────────────────────────────────┘
 *
 * Buttons are large (icon + label). `main.ts` stays the orchestrator — the
 * ribbon only emits semantic actions and reflects state it is told about.
 */

export type RibbonAction =
  | 'open-program'
  | 'reload'
  | 'backplot'
  | 'clear'
  | 'review'
  | 'scope-all'
  | 'scope-front'
  | 'scope-back'
  | 'scope-selection'
  | 'play'
  | 'rewind'
  | 'stepBack'
  | 'stepFwd'
  | 'toggle-loop'
  | 'speed-0.25'
  | 'speed-1'
  | 'speed-2'
  | 'speed-5'
  | 'layout-split'
  | 'layout-editor'
  | 'layout-3d'
  | 'view-fit'
  | 'view-iso'
  | 'view-top'
  | 'view-front'
  | 'view-right'
  | 'toggle-rapids'
  | 'toggle-grid'
  | 'toggle-machine'
  | 'km-swiss'
  | 'km-lathe'
  | 'dialect-fanuc'
  | 'dialect-mitsubishi'
  | 'dialect-citizen'
  | 'load-machine'
  | 'setup'
  | 'help';

interface Btn {
  action: RibbonAction;
  label: string;
  glyph: string;
  size?: 'lg' | 'sm';
  primary?: boolean;
  toggle?: boolean;
  on?: boolean;
  segment?: string; // radio group id — clicking sets `.active`, clears siblings
}

interface Panel {
  title: string;
  buttons: Btn[];
}

interface Tab {
  id: string;
  label: string;
  panels: Panel[];
}

const TABS: Tab[] = [
  {
    id: 'home',
    label: 'Home',
    panels: [
      {
        title: 'Program',
        buttons: [
          { action: 'open-program', label: 'Open\nProgram', glyph: '📂', size: 'lg' },
          { action: 'reload', label: 'Reload', glyph: '⟳', size: 'sm' },
        ],
      },
      {
        title: 'Backplot',
        buttons: [
          { action: 'backplot', label: 'Run\nBackplot', glyph: '▶︎', size: 'lg', primary: true },
          { action: 'clear', label: 'Clear', glyph: '⌫', size: 'sm' },
          { action: 'review', label: 'Review', glyph: '✓', size: 'sm' },
        ],
      },
      {
        title: 'Show',
        buttons: [
          { action: 'scope-all', label: 'All\npaths', glyph: '▦', size: 'sm', segment: 'scope', on: true },
          { action: 'scope-front', label: 'Front\n($1)', glyph: '◐', size: 'sm', segment: 'scope' },
          { action: 'scope-back', label: 'Back\n($2)', glyph: '◑', size: 'sm', segment: 'scope' },
          { action: 'scope-selection', label: 'Selected\nlines', glyph: '⊟', size: 'sm', segment: 'scope' },
        ],
      },
    ],
  },
  {
    id: 'simulate',
    label: 'Simulate',
    panels: [
      {
        title: 'Transport',
        buttons: [
          { action: 'rewind', label: 'Rewind', glyph: '⏮', size: 'sm' },
          { action: 'play', label: 'Play', glyph: '▶', size: 'lg', primary: true },
          { action: 'stepBack', label: 'Step\nBack', glyph: '⏪', size: 'sm' },
          { action: 'stepFwd', label: 'Step\nFwd', glyph: '⏩', size: 'sm' },
        ],
      },
      {
        title: 'Speed',
        buttons: [
          { action: 'speed-0.25', label: '0.25×', glyph: '¼', size: 'sm', segment: 'speed' },
          { action: 'speed-1', label: '1×', glyph: '1', size: 'sm', segment: 'speed', on: true },
          { action: 'speed-2', label: '2×', glyph: '2', size: 'sm', segment: 'speed' },
          { action: 'speed-5', label: '5×', glyph: '5', size: 'sm', segment: 'speed' },
        ],
      },
      {
        title: 'Options',
        buttons: [{ action: 'toggle-loop', label: 'Loop', glyph: '↻', size: 'sm', toggle: true }],
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    panels: [
      {
        title: 'Layout',
        buttons: [
          { action: 'layout-split', label: 'Code +\n3D', glyph: '▤', size: 'sm', segment: 'layout', on: true },
          { action: 'layout-editor', label: 'Code\nonly', glyph: '▥', size: 'sm', segment: 'layout' },
          { action: 'layout-3d', label: '3D\nonly', glyph: '◨', size: 'sm', segment: 'layout' },
        ],
      },
      {
        title: 'Camera',
        buttons: [
          { action: 'view-fit', label: 'Fit', glyph: '⤢', size: 'lg' },
          { action: 'view-iso', label: 'Iso', glyph: '◈', size: 'sm' },
          { action: 'view-top', label: 'Top', glyph: '▦', size: 'sm' },
          { action: 'view-front', label: 'Front', glyph: '▥', size: 'sm' },
          { action: 'view-right', label: 'Right', glyph: '◨', size: 'sm' },
        ],
      },
      {
        title: 'Display',
        buttons: [
          { action: 'toggle-rapids', label: 'Rapids', glyph: '⇢', size: 'sm', toggle: true, on: true },
          { action: 'toggle-grid', label: 'Grid', glyph: '▩', size: 'sm', toggle: true, on: true },
          { action: 'toggle-machine', label: 'Machine', glyph: '⛭', size: 'sm', toggle: true, on: true },
        ],
      },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    panels: [
      {
        title: 'Machine',
        buttons: [
          { action: 'load-machine', label: 'Load\nMachine', glyph: '🛠', size: 'lg' },
          { action: 'setup', label: 'Setup\nEditor', glyph: '⚙', size: 'sm' },
        ],
      },
      {
        title: 'Kinematics',
        buttons: [
          { action: 'km-swiss', label: 'Swiss\nType', glyph: '⟼', size: 'sm', segment: 'km', on: true },
          { action: 'km-lathe', label: 'Standard\nLathe', glyph: '⊙', size: 'sm', segment: 'km' },
        ],
      },
      {
        title: 'Control',
        buttons: [
          { action: 'dialect-fanuc', label: 'Fanuc', glyph: 'F', size: 'sm', segment: 'dialect', on: true },
          { action: 'dialect-mitsubishi', label: 'Mitsu', glyph: 'M', size: 'sm', segment: 'dialect' },
          { action: 'dialect-citizen', label: 'Citizen', glyph: 'C', size: 'sm', segment: 'dialect' },
        ],
      },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    panels: [
      {
        title: 'Reference',
        buttons: [{ action: 'help', label: 'Codes &\nMachine', glyph: '?', size: 'lg' }],
      },
    ],
  },
];

export class Ribbon {
  private activeTab = 'home';
  private readonly toggles = new Map<RibbonAction, boolean>();
  private readonly segments = new Map<string, RibbonAction>();
  private state = { program: undefined as string | undefined, mode: '', playing: false, backplot: false };

  constructor(
    private readonly host: HTMLElement,
    private readonly onAction: (a: RibbonAction) => void
  ) {
    host.className = 'ribbon';
    for (const t of TABS)
      for (const p of t.panels)
        for (const b of p.buttons) {
          if (b.toggle) this.toggles.set(b.action, !!b.on);
          if (b.segment && b.on) this.segments.set(b.segment, b.action);
        }

    this.paint();

    host.addEventListener('click', (e) => {
      const tabEl = (e.target as HTMLElement).closest('.rb-tab') as HTMLElement | null;
      if (tabEl) {
        this.activeTab = tabEl.dataset.tab!;
        this.paint();
        return;
      }
      const btn = (e.target as HTMLElement).closest('button.rb-btn') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action as RibbonAction;

      if (this.toggles.has(action)) {
        const next = !this.toggles.get(action);
        this.toggles.set(action, next);
        btn.classList.toggle('on', next);
      }
      const seg = btn.dataset.segment;
      if (seg) {
        this.segments.set(seg, action);
        this.host
          .querySelectorAll(`.rb-btn[data-segment="${seg}"]`)
          .forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
      }
      this.onAction(action);
    });
  }

  private paint(): void {
    const tab = TABS.find((t) => t.id === this.activeTab)!;
    this.host.innerHTML = `
      <div class="rb-titlebar">
        <span class="rb-app">OpenPlotCNC</span>
        <span class="rb-crumb" data-role="program">No program</span>
        <span class="rb-spacer"></span>
        <span class="rb-status" data-role="mode"></span>
      </div>
      <div class="rb-tabs">
        ${TABS.map(
          (t) =>
            `<button class="rb-tab${t.id === this.activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
        ).join('')}
      </div>
      <div class="rb-body">
        ${tab.panels
          .map(
            (p) => `
          <div class="rb-panel">
            <div class="rb-panel-row">
              ${p.buttons.map((b) => this.btn(b)).join('')}
            </div>
            <div class="rb-panel-title">${p.title}</div>
          </div>`
          )
          .join('')}
      </div>`;
    this.applyState();
  }

  private applyState(): void {
    this.setProgram(this.state.program);
    this.setMode(this.state.mode);
    this.setPlaying(this.state.playing);
    this.setBackplotActive(this.state.backplot);
  }

  private btn(b: Btn): string {
    const cls = [
      'rb-btn',
      b.size === 'lg' ? 'lg' : 'sm',
      b.primary ? 'primary' : '',
      b.toggle ? 'toggle' : '',
      b.toggle && this.toggles.get(b.action) ? 'on' : '',
      b.segment && this.segments.get(b.segment) === b.action ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<button class="${cls}" data-action="${b.action}"${
      b.segment ? ` data-segment="${b.segment}"` : ''
    } title="${b.label.replace(/\n/g, ' ')}">
      <span class="rb-glyph">${b.glyph}</span>
      <span class="rb-label">${b.label.replace(/\n/g, '<br>')}</span>
    </button>`;
  }

  /* ---- state the orchestrator pushes back ---- */
  setProgram(name: string | undefined): void {
    this.state.program = name;
    const el = this.host.querySelector('[data-role="program"]');
    if (el) el.textContent = name ?? 'No program';
  }

  setMode(text: string): void {
    this.state.mode = text;
    const el = this.host.querySelector('[data-role="mode"]');
    if (el) el.textContent = text;
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
    const b = this.host.querySelector('[data-action="play"]');
    if (!b) return;
    b.querySelector('.rb-glyph')!.textContent = playing ? '⏸' : '▶';
    b.querySelector('.rb-label')!.innerHTML = playing ? 'Pause' : 'Play';
  }

  setBackplotActive(active: boolean): void {
    this.state.backplot = active;
    const gated: RibbonAction[] = ['play', 'rewind', 'stepBack', 'stepFwd', 'clear'];
    for (const a of gated) {
      const b = this.host.querySelector(`[data-action="${a}"]`) as HTMLButtonElement | null;
      if (b) b.disabled = !active;
    }
    const run = this.host.querySelector('[data-action="backplot"]');
    run?.classList.toggle('done', active);
  }

  setSegment(group: string, action: RibbonAction): void {
    this.host
      .querySelectorAll(`.rb-btn[data-segment="${group}"]`)
      .forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.action === action));
  }

  isOn(action: RibbonAction): boolean {
    return this.toggles.get(action) ?? false;
  }

  showTab(id: string): void {
    this.activeTab = id;
    this.paint();
  }
}
