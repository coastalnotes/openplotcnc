import './editor/monacoEnv';
import './styles.css';

import { onHostMessage, send } from './ipc';
import { MultiChannelEditor } from './editor/multiChannelEditor';
import { SceneManager } from './render/sceneManager';
import { Animator } from './render/animator';
import { mountTransport } from './playback/controls';
import { ConfigPanel } from './config/configPanel';
import { HelpPanel } from './ui/helpPanel';
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

const config = new ConfigPanel(el('config-modal'), (next) => {
  setup = next;
  send({ type: 'saveSetup', setup: next });
  applySetup();
  updateChannelsInfo();
  if (backplotActive) runBackplot();
}, MACHINE_TEMPLATES);

const help = new HelpPanel(el('help-modal'));

const ribbon = new Ribbon(el('ribbon'), onRibbon);
mountTransport(el('transport'), animator);
el('idle-run').addEventListener('click', runBackplot);

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
el('btn-sync-report').addEventListener('click', () => {
  toggleSyncReport();
  el('btn-sync-report').classList.toggle('on', !el('sync-report').hidden);
});
setLayout(readStoredLayout());

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
      ribbon.showTab('simulate');
      break;
    case 'clear':
      clearBackplot();
      break;
    case 'sync-report':
      toggleSyncReport();
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

function toggleSyncReport(): void {
  const box = el('sync-report');
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const program = parseMultiChannel(resolvedTexts(), { dialect: setup.machine.dialect });
  const align = alignChannels(program);
  if (align.barriers.length === 0) {
    box.innerHTML = `<div class="sr-empty">No wait / sync codes found across channels.</div>`;
  } else {
    box.innerHTML = align.barriers
      .map((b) => {
        const parts = [...b.participants.entries()]
          .map(([ch, ln]) => `CH${ch}·L${ln + 1}`)
          .join('  ');
        return `<div class="sr-row ${b.matched ? 'ok' : 'warn'}">
          <span class="sr-id">${b.raw || b.id}</span>
          <span class="sr-parts">${parts}</span>
          <span class="sr-flag">${b.matched ? 'aligned' : 'only 1 channel'}</span>
        </div>`;
      })
      .join('');
  }
  box.hidden = false;
}

/* ---- backplot lifecycle (manual) ---- */
function runBackplot(): void {
  const texts = resolvedTexts();
  if (texts.length === 0) return;
  const program = parseMultiChannel(texts, { dialect: setup.machine.dialect });
  schedule = buildSchedule(program, setup);
  scene.setToolpaths(schedule.channels);
  scene.setRapidsVisible(ribbon.isOn('toggle-rapids'));
  animator.setSchedule(schedule);
  animator.seek(0);

  backplotActive = true;
  ribbon.setBackplotActive(true);
  el('viewport-idle').hidden = true;
  scene.resize();

  const moves = schedule.channels.reduce((n, c) => n + c.segments.length, 0);
  el('viewport-info').textContent =
    `${schedule.channels.length} paths · ${moves} moves · ${schedule.duration.toFixed(1)} s cycle`;
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
  const texts = resolvedTexts();
  const program = parseMultiChannel(texts, { dialect: setup.machine.dialect });
  const align = alignChannels(program);
  const matched = align.barriers.filter((b) => b.matched).length;
  const subCount = subprograms.size;
  const parts = [`${texts.length} channel${texts.length === 1 ? '' : 's'}`];
  if (texts.length > 1) parts.push(`${matched} sync point${matched === 1 ? '' : 's'} aligned`);
  if (subCount) parts.push(`${subCount} subprogram${subCount === 1 ? '' : 's'}`);
  el('channels-info').textContent = parts.join(' · ');
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
