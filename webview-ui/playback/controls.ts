import type { Animator, Frame } from '../render/animator';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Build the transport bar and bind it to the animator. */
export function mountTransport(host: HTMLElement, animator: Animator): void {
  host.innerHTML = `
    <button data-act="stepBack" title="Step back">⏮</button>
    <button data-act="toggle" title="Play / Pause" class="primary">▶</button>
    <button data-act="stepFwd" title="Step forward">⏭</button>
    <input data-act="scrub" type="range" min="0" max="1000" value="0" step="1" />
    <span data-role="time" class="mono">0:00.0</span>
    <span class="sep">/</span>
    <span data-role="dur" class="mono">0:00.0</span>
    <label class="speed">
      <span data-role="speedval" class="mono">1.0×</span>
      <input data-act="speed" type="range" min="-1" max="1" step="0.01" value="0" />
    </label>
  `;

  const $ = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;
  const scrub = $<HTMLInputElement>('[data-act="scrub"]');
  const speed = $<HTMLInputElement>('[data-act="speed"]');
  const timeEl = $<HTMLSpanElement>('[data-role="time"]');
  const durEl = $<HTMLSpanElement>('[data-role="dur"]');
  const speedVal = $<HTMLSpanElement>('[data-role="speedval"]');
  const toggleBtn = $<HTMLButtonElement>('[data-act="toggle"]');

  let scrubbing = false;

  host.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'toggle') animator.toggle();
    else if (act === 'stepFwd') animator.stepForward();
    else if (act === 'stepBack') animator.stepBack();
  });

  scrub.addEventListener('input', () => {
    scrubbing = true;
    animator.seek((Number(scrub.value) / 1000) * animator.duration);
  });
  scrub.addEventListener('change', () => {
    scrubbing = false;
  });

  // Log-scaled speed: slider -1..1 -> 0.1..10
  speed.addEventListener('input', () => {
    const s = Math.pow(10, Number(speed.value));
    animator.setSpeed(s);
  });

  animator.subscribe((f: Frame) => {
    toggleBtn.textContent = f.playing ? '⏸' : '▶';
    timeEl.textContent = fmt(f.time);
    durEl.textContent = fmt(f.duration);
    speedVal.textContent = `${f.speed.toFixed(1)}×`;
    if (!scrubbing && f.duration > 0) {
      scrub.value = String(Math.round((f.time / f.duration) * 1000));
    }
  });
}
