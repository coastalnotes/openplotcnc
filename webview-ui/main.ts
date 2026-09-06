import './editor/monacoEnv';
import './styles.css';

import { onHostMessage, send } from './ipc';
import { MultiChannelEditor } from './editor/multiChannelEditor';
import { SceneManager } from './render/sceneManager';
import { Animator } from './render/animator';
import { mountTransport } from './playback/controls';
import { ConfigPanel } from './config/configPanel';
import { HelpPanel } from './ui/helpPanel';
import { ReviewPanel } from './ui/reviewPanel';
import { Ribbon, type RibbonAction } from './ui/ribbon';
import { parseMultiChannel, expandSubprograms } from '../src/parser';
import { alignChannels } from '../src/channels/alignment';
import { buildSchedule, type Schedule } from '../src/simulation/timeline';
import { channelSpace } from '../src/kinematics/swissTransform';
import { defaultSetup } from '../src/config/defaults';
import { getTemplate, MACHINE_TEMPLATES } from '../src/machines';
import type { HostToWebview, SetupConfig } from '../src/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let setup: SetupConfig = defaultSetup();
let schedule: Schedule | undefined;
let backplotActive = false;
let liveTimer: number | undefined;
let subprograms = new Map<number, string>();

type BackplotScope = 'all' | 'front' | 'back' | 'selection';
let scope: BackplotScope = readStoredScope();

function readStoredScope(): BackplotScope {
  try {
    const v = localStorage.getItem('opc.scope');
    if (v === 'front' || v === 'back' || v === 'selection' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

/** Channel texts with `M98` subprogram calls expanded, for parsing/backplot. */
function resolvedTexts() {
  return editor.channelTexts().map((t) => ({
    channel: t.channel,
    name: t.name,
    source: expandSubprograms(t.source, subprograms),
  }));
}

const canvas = el<HTMLCanvasElement>('scene');
const scene = new SceneManager(canvas);
const animator = new Animator();

const editor = new MultiChannelEditor(el('editors'), {
  onEdit: (channel, text) => {
    send({ type: 'edit', channel, text });
    updateChannelsInfo();
    if (backplotActive) scheduleLiveRebuild();
  },
  onCursor: (channel, line) => send({ type: 'cursor', channel, line }),
});

let selectionTimer: number | undefined;
editor.onSelectionChange(() => {
  if (scope !== 'selection') return;
  if (selectionTimer) window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => runBackplot(), 350);
});

const config = new ConfigPanel(el('config-modal'), (next) => {
  setup = next;
  send({ type: 'saveSetup', setup: next });
  applySetup();
  updateChannelsInfo();
  if (backplotActive) runBackplot();
}, MACHINE_TEMPLATES);

const help = new HelpPanel(el('help-modal'));
const review = new ReviewPanel(el('review-panel'), (channel, line) => {
  editor.revealChannelLine(channel, line);
});

const ribbon = new Ribbon(el('ribbon'), onRibbon);
mountTransport(el('transport'), animator);
el('idle-run').addEventListener('click', runBackplot);

/** Raw channel text (what the columns show) for alignment / review. */
function rawTexts() {
  return editor.channelTexts().map((t) => ({
    channel: t.channel,
    name: t.name,
    source: t.source,
  }));
}

/* ---- pane layout (Code + 3D / Code only / 3D only) ---- */
type Layout = 'split' | 'editor' | '3d';
function readStoredLayout(): Layout {
  try {
    const v = localStorage.getItem('opc.layout');
    if (v === 'editor' || v === '3d' || v === 'split') return v;
  } catch {
    /* private mode */
  }
  return 'split';
}
function setLayout(mode: Layout): void {
  el('app').dataset.layout = mode;
  try {
    localStorage.setItem('opc.layout', mode);
  } catch {
    /* ignore */
  }
  ribbon.setSegment('layout', `layout-${mode}` as RibbonAction);
  el('btn-expand-editor').classList.toggle('on', mode === 'editor');
  requestAnimationFrame(() => {
    scene.resize();
    editor.layout();
  });
}

el('btn-expand-editor').addEventListener('click', () => {
  setLayout(el('app').dataset.layout === 'editor' ? 'split' : 'editor');
});
el('btn-review').addEventListener('click', () => openReview());
setLayout(readStoredLayout());

function openReview(): void {
  review.toggle(rawTexts(), setup.machine.dialect);
  const btn = el('btn-review');
  btn.classList.toggle('on', review.visible);
  btn.classList.toggle('has-issues', review.issueCount > 0);
  btn.textContent = review.issueCount > 0 ? `Review · ${review.issueCount}` : 'Review';
  requestAnimationFrame(() => editor.layout());
}

/* ---- ribbon actions ---- */
function onRibbon(a: RibbonAction): void {
  switch (a) {
    case 'open-program':
      send({ type: 'pickProgram' });
      break;
    case 'reload':
      send({ type: 'requestChannels' });
      break;
    case 'backplot':
      runBackplot();
      break;
    case 'clear':
      clearBackplot();
      break;
    case 'review':
      openReview();
      break;
    case 'scope-all':
    case 'scope-front':
    case 'scope-back':
    case 'scope-selection':
      setScope(a.replace('scope-', '') as BackplotScope);
      break;
    case 'play':
      animator.toggle();
      break;
    case 'rewind':
      animator.seek(0);
      break;
    case 'stepBack':
      animator.stepBack();
      break;
    case 'stepFwd':
      animator.stepForward();
      break;
    case 'toggle-loop':
      animator.setLoop(ribbon.isOn('toggle-loop'));
      break;
    case 'speed-0.25':
      animator.setSpeed(0.25);
      break;
    case 'speed-1':
      animator.setSpeed(1);
      break;
    case 'speed-2':
      animator.setSpeed(2);
      break;
    case 'speed-5':
      animator.setSpeed(5);
      break;
    case 'layout-split':
      setLayout('split');
      break;
    case 'layout-editor':
      setLayout('editor');
      break;
    case 'layout-3d':
      setLayout('3d');
      break;
    case 'view-fit':
      scene.frameAll();
      break;
    case 'view-iso':
      scene.setView('iso');
      break;
    case 'view-top':
      scene.setView('top');
      break;
    case 'view-front':
      scene.setView('front');
      break;
    case 'view-right':
      scene.setView('right');
      break;
    case 'toggle-rapids':
      scene.setRapidsVisible(ribbon.isOn('toggle-rapids'));
      break;
    case 'toggle-grid':
      scene.setGridVisible(ribbon.isOn('toggle-grid'));
      break;
    case 'toggle-machine':
      scene.setMachineVisible(ribbon.isOn('toggle-machine'));
      break;
    case 'km-swiss':
    case 'km-lathe':
      setup.machine.kinematicsMode = a === 'km-swiss' ? 'swiss-type' : 'standard-lathe';
      send({ type: 'saveSetup', setup });
      applySetup();
      if (backplotActive) runBackplot();
      break;
    case 'dialect-fanuc':
    case 'dialect-mitsubishi':
    case 'dialect-citizen':
      setup.machine.dialect =
        a === 'dialect-fanuc' ? 'fanuc' : a === 'dialect-citizen' ? 'citizen' : 'mitsubishi';
      send({ type: 'saveSetup', setup });
      applySetup();
      updateChannelsInfo();
      if (backplotActive) runBackplot();
      break;
    case 'load-machine':
      send({ type: 'pickMachine' });
      break;
    case 'setup':
      config.show();
      break;
    case 'help':
      help.toggle();
      break;
  }
}

function setScope(next: BackplotScope): void {
  scope = next;
  try {
    localStorage.setItem('opc.scope', next);
  } catch {
    /* ignore */
  }
  ribbon.setSegment('scope', `scope-${next}` as RibbonAction);
  if (backplotActive) runBackplot();
}

/** Filter a solved schedule down to the current backplot scope. */
function applyScope(full: Schedule): { schedule: Schedule; label: string } {
  if (scope === 'all') return { schedule: full, label: 'all paths' };

  if (scope === 'front' || scope === 'back') {
    const want = scope === 'front' ? 'main' : 'sub';
    const channels = full.channels.filter((c) => channelSpace(setup, c.channel) === want);
    return {
      schedule: { ...full, channels, duration: Math.max(0, ...channels.map((c) => c.endWall)) },
      label: `${scope} spindle`,
    };
  }

  // 'selection' — keep only segments whose source line is selected.
  const sel = editor.selections();
  const channels = full.channels
    .map((c) => {
      const ranges = sel.get(c.channel);
      if (!ranges) return { ...c, segments: [] };
      let t = 0;
      const segments = c.segments
        .filter((s) => ranges.some(([a, b]) => s.sourceLine >= a && s.sourceLine <= b))
        .map((s) => {
          const seg = { ...s, tStartWall: t, tEndWall: t + s.durationSec };
          t += s.durationSec;
          return seg;
        });
      return { ...c, segments, endWall: t };
    })
    .filter((c) => c.segments.length > 0);
  const total = sel.size === 0 ? 0 : channels.length;
  return {
    schedule: {
      ...full,
      channels,
      barriers: [],
      duration: Math.max(0, ...channels.map((c) => c.endWall)),
    },
    label: total === 0 ? 'nothing selected — select lines in the editor' : 'selected lines',
  };
}

/* ---- backplot lifecycle (manual) ---- */
function runBackplot(): void {
  const texts = resolvedTexts();
  if (texts.length === 0) return;
  const program = parseMultiChannel(texts, { dialect: setup.machine.dialect });
  const full = buildSchedule(program, setup);
  const scoped = applyScope(full);
  schedule = scoped.schedule;
  scene.setToolpaths(schedule.channels);
  scene.setRapidsVisible(ribbon.isOn('toggle-rapids'));
  animator.setSchedule(schedule);
  animator.seek(0);

  ribbon.setSegment('scope', `scope-${scope}` as RibbonAction);

  if (schedule.channels.length === 0) {
    // Scope produced nothing (e.g. "Selected lines" with no selection).
    backplotActive = false;
    ribbon.setBackplotActive(false);
    el('viewport-idle').hidden = false;
    el('idle-hint-text').textContent =
      scope === 'selection'
        ? 'Select the G-code lines you want to plot, then Run Backplot.'
        : `No ${scope}-spindle path in this program.`;
    el('viewport-info').textContent = '';
    return;
  }

  backplotActive = true;
  ribbon.setBackplotActive(true);
  el('viewport-idle').hidden = true;
  scene.resize();

  const moves = schedule.channels.reduce((n, c) => n + c.segments.length, 0);
  el('viewport-info').textContent =
    `${scoped.label} · ${schedule.channels.length} path${schedule.channels.length === 1 ? '' : 's'} · ` +
    `${moves} moves · ${schedule.duration.toFixed(1)} s`;

  // Run mode doubles as an error check — surface it when there is something to see.
  const issues = review.refresh(rawTexts(), setup.machine.dialect);
  el('btn-review').classList.toggle('has-issues', issues > 0);
  el('btn-review').textContent = issues > 0 ? `Review · ${issues}` : 'Review';
  if (issues > 0 && !review.visible) openReview();
  ribbon.showTab('simulate');
}

function clearBackplot(): void {
  animator.pause();
  animator.seek(0);
  scene.clearToolpaths();
  schedule = undefined;
  backplotActive = false;
  ribbon.setBackplotActive(false);
  ribbon.setPlaying(false);
  el('viewport-idle').hidden = false;
  el('viewport-info').textContent = '';
}

function scheduleLiveRebuild(): void {
  if (liveTimer) window.clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    if (backplotActive) runBackplot();
  }, 400);
}

/* ---- resize plumbing ---- */
const ro = new ResizeObserver(() => {
  scene.resize();
  editor.layout();
});
ro.observe(el('viewport'));
ro.observe(el('editors'));
window.addEventListener('resize', () => scene.resize());
scene.resize();

/* ---- gutter drag ---- */
(() => {
  const gutter = el('gutter');
  const split = el('split');
  let dragging = false;
  gutter.addEventListener('pointerdown', (e) => {
    dragging = true;
    gutter.setPointerCapture(e.pointerId);
  });
  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const pct = Math.min(0.82, Math.max(0.18, (e.clientX - rect.left) / rect.width));
    split.style.gridTemplateColumns = `${pct * 100}% 6px 1fr`;
    scene.resize();
    editor.layout();
  });
  gutter.addEventListener('pointerup', () => (dragging = false));
})();

/* ---- host messages ---- */
onHostMessage((msg: HostToWebview) => {
  switch (msg.type) {
    case 'init':
      setup = msg.setup;
      subprograms = toSubMap(msg.subprograms);
      config.setSetup(setup);
      applyTheme(msg.theme);
      editor.setChannels(msg.channels, setup.machine.dialect);
      ribbon.setProgram(`${msg.program}  ·  ${msg.mode === 'single-file' ? 'single file' : 'multi file'}`);
      applySetup();
      updateChannelsInfo();
      if (backplotActive) runBackplot();
      break;
    case 'channels':
      subprograms = toSubMap(msg.subprograms);
      editor.setChannels(msg.channels, setup.machine.dialect);
      ribbon.setProgram(`${msg.program}  ·  ${msg.mode === 'single-file' ? 'single file' : 'multi file'}`);
      updateChannelsInfo();
      if (backplotActive) runBackplot();
      break;
    case 'setup':
      setup = msg.setup;
      config.setSetup(setup);
      applySetup();
      break;
    case 'openConfig':
      config.show();
      break;
    case 'theme':
      applyTheme(msg.theme);
      break;
    case 'setLayout':
      setLayout(msg.layout);
      break;
    case 'revealLine':
      editor.revealChannelLine(msg.channel, msg.line);
      break;
  }
});

send({ type: 'ready' });

/* ---- glue ---- */
function applyTheme(theme: 'light' | 'dark'): void {
  document.body.dataset.theme = theme;
  editor.setTheme(theme);
  scene.setTheme(theme);
}

const DIALECT_LABEL = { fanuc: 'Fanuc', mitsubishi: 'Mitsubishi', citizen: 'Citizen Cincom' } as const;

function applySetup(): void {
  scene.setSetup(setup);
  const tpl = setup.template ? getTemplate(setup.template) : undefined;
  const km = setup.machine.kinematicsMode === 'swiss-type' ? 'Swiss-type' : 'Standard lathe';
  ribbon.setMode(
    `${tpl ? tpl.name + '  ·  ' : ''}${km} · ${DIALECT_LABEL[setup.machine.dialect]}`
  );
  ribbon.setSegment('scope', `scope-${scope}` as RibbonAction);
  ribbon.setSegment('km', setup.machine.kinematicsMode === 'swiss-type' ? 'km-swiss' : 'km-lathe');
  ribbon.setSegment(
    'dialect',
    setup.machine.dialect === 'fanuc'
      ? 'dialect-fanuc'
      : setup.machine.dialect === 'citizen'
        ? 'dialect-citizen'
        : 'dialect-mitsubishi'
  );
  help.setContext(setup.machine.dialect, tpl);
}

function updateChannelsInfo(): void {
  const texts = editor.channelTexts();
  const program = parseMultiChannel(
    texts.map((t) => ({ channel: t.channel, name: t.name, source: t.source })),
    { dialect: setup.machine.dialect }
  );
  const align = alignChannels(program);
  const matched = align.barriers.filter((b) => b.matched).length;
  const subCount = subprograms.size;
  const parts = [`${texts.length} channel${texts.length === 1 ? '' : 's'}`];
  if (texts.length > 1) parts.push(`${matched} sync point${matched === 1 ? '' : 's'} aligned`);
  if (subCount) parts.push(`${subCount} subprogram${subCount === 1 ? '' : 's'}`);
  el('channels-info').textContent = parts.join(' · ');

  const issues = review.refresh(rawTexts(), setup.machine.dialect);
  const btn = el('btn-review');
  btn.classList.toggle('has-issues', issues > 0);
  btn.textContent = issues > 0 ? `Review · ${issues}` : 'Review';
}

animator.subscribe((frame) => {
  ribbon.setPlaying(frame.playing);
  if (!backplotActive) return;

  const positions = new Map<number, { pos: any; waiting: boolean }>();
  const highlight = new Map<number, { line: number; waiting: boolean }>();
  for (const [ch, st] of frame.channels) {
    positions.set(ch, { pos: st.pos, waiting: st.waiting });
    highlight.set(ch, { line: st.sourceLine, waiting: st.waiting });
  }
  scene.updatePlayback(frame.time, positions);
  editor.highlightExecuting(highlight);

  if (schedule) {
    const mainId = mainChannelId();
    const mainCh = schedule.channels.find((c) => c.channel === mainId);
    const st = frame.channels.get(mainId);
    if (mainCh && st && mainCh.segments[st.segIndex]) {
      const subCh = schedule.channels.find((c) => channelSpace(setup, c.channel) === 'sub');
      const subSt = subCh ? frame.channels.get(subCh.channel) : undefined;
      const subSeg =
        subCh && subSt && subCh.segments[subSt.segIndex]
          ? subCh.segments[subSt.segIndex].headstockZ
          : undefined;
      scene.setHeadstock(mainCh.segments[st.segIndex].headstockZ, subSeg);
    }
  }
});

function toSubMap(rec: Record<number, string> | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, v] of Object.entries(rec ?? {})) m.set(Number(k), v);
  return m;
}

function mainChannelId(): number {
  const first = setup.machine.channels.find((c) => channelSpace(setup, c.id) === 'main');
  return first?.id ?? setup.machine.channels[0]?.id ?? 1;
}
