import './editor/monacoEnv';
import './styles.css';

import { onHostMessage, send } from './ipc';
import { MultiChannelEditor } from './editor/multiChannelEditor';
import { SceneManager } from './render/sceneManager';
import { Animator } from './render/animator';
import { mountTransport } from './playback/controls';
import { ConfigPanel } from './config/configPanel';
import { parseMultiChannel } from '../src/parser';
import { buildSchedule, type Schedule } from '../src/simulation/timeline';
import { channelSpace } from '../src/kinematics/swissTransform';
import { defaultSetup } from '../src/config/defaults';
import type { HostToWebview, SetupConfig } from '../src/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let setup: SetupConfig = defaultSetup();
let schedule: Schedule | undefined;
let rebuildTimer: number | undefined;

const canvas = el<HTMLCanvasElement>('scene');
const scene = new SceneManager(canvas);
const animator = new Animator();

const editor = new MultiChannelEditor(el('editors'), {
  onEdit: (channel, text) => {
    send({ type: 'edit', channel, text });
    scheduleRebuild();
  },
  onCursor: (channel, line) => send({ type: 'cursor', channel, line }),
});

const config = new ConfigPanel(el('config-modal'), (next) => {
  setup = next;
  send({ type: 'saveSetup', setup: next });
  applySetup();
});

mountTransport(el('transport'), animator);
buildToolbar();

function buildToolbar(): void {
  el('toolbar').innerHTML = `
    <span class="brand">OpenPlotCNC</span>
    <span class="tag" data-role="mode"></span>
    <span class="spacer"></span>
    <button data-act="frame" class="ghost">Fit view</button>
    <button data-act="config" class="ghost">Setup…</button>
  `;
  el('toolbar').addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    if (act === 'frame') scene.frameAll();
    if (act === 'config') config.show();
  });
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
    const pct = Math.min(0.8, Math.max(0.2, (e.clientX - rect.left) / rect.width));
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
      config.setSetup(setup);
      applyTheme(msg.theme);
      editor.setChannels(msg.channels, setup.machine.dialect);
      applySetup();
      break;
    case 'channels':
      editor.setChannels(msg.channels, setup.machine.dialect);
      rebuildSimulation();
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

function applySetup(): void {
  scene.setSetup(setup);
  const modeTag = document.querySelector('[data-role="mode"]');
  if (modeTag) {
    modeTag.textContent = `${setup.machine.kinematicsMode} · ${setup.machine.dialect}`;
  }
  rebuildSimulation();
}

function scheduleRebuild(): void {
  if (rebuildTimer) window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(rebuildSimulation, 300);
}

function rebuildSimulation(): void {
  const texts = editor.channelTexts();
  if (texts.length === 0) return;
  const program = parseMultiChannel(
    texts.map((t) => ({ channel: t.channel, name: t.name, source: t.source })),
    { dialect: setup.machine.dialect }
  );
  schedule = buildSchedule(program, setup);
  scene.setToolpaths(schedule.channels);
  animator.setSchedule(schedule);
}

const mainChannelId = () => {
  const first = setup.machine.channels.find((c) => channelSpace(setup, c.id) === 'main');
  return first?.id ?? setup.machine.channels[0]?.id ?? 1;
};

animator.subscribe((frame) => {
  const positions = new Map<number, { pos: any; waiting: boolean }>();
  const highlight = new Map<number, { line: number; waiting: boolean }>();
  for (const [ch, st] of frame.channels) {
    positions.set(ch, { pos: st.pos, waiting: st.waiting });
    highlight.set(ch, { line: st.sourceLine, waiting: st.waiting });
  }
  scene.updatePlayback(frame.time, positions);
  editor.highlightExecuting(highlight);

  if (schedule) {
    const mainCh = schedule.channels.find((c) => c.channel === mainChannelId());
    const st = frame.channels.get(mainChannelId());
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
