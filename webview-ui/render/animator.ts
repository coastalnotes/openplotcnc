import type { Schedule } from '../../src/simulation/timeline';
import { sampleAt } from '../../src/simulation/timeline';
import type { Vec3 } from '../../src/types';

export interface ChannelFrameState {
  pos: Vec3;
  sourceLine: number;
  waiting: boolean;
  segIndex: number;
}

export interface Frame {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
  /** channel -> current state. */
  channels: Map<number, ChannelFrameState>;
}

type Sub = (f: Frame) => void;

export class Animator {
  private schedule: Schedule | undefined;
  private eventTimes: number[] = [];
  private time = 0;
  private playing = false;
  private speed = 1;
  private loop = false;
  private lastTs = 0;
  private raf = 0;
  private subs = new Set<Sub>();

  setSchedule(schedule: Schedule): void {
    this.schedule = schedule;
    const ts = new Set<number>([0, schedule.duration]);
    for (const ch of schedule.channels) {
      for (const s of ch.segments) {
        ts.add(round(s.tStartWall));
        ts.add(round(s.tEndWall));
      }
    }
    for (const b of schedule.barriers) ts.add(round(b.releaseWall));
    this.eventTimes = [...ts].filter((t) => t >= 0).sort((a, b) => a - b);
    this.time = Math.min(this.time, schedule.duration);
    this.emit();
  }

  get duration(): number {
    return this.schedule?.duration ?? 0;
  }

  subscribe(cb: Sub): () => void {
    this.subs.add(cb);
    cb(this.frame());
    return () => this.subs.delete(cb);
  }

  play(): void {
    if (!this.schedule || this.playing) return;
    if (this.time >= this.duration) this.time = 0;
    this.playing = true;
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    this.time = clamp(t, 0, this.duration);
    this.emit();
  }

  setSpeed(s: number): void {
    this.speed = clamp(s, 0.1, 10);
    this.emit();
  }

  setLoop(on: boolean): void {
    this.loop = on;
  }

  stepForward(): void {
    const next = this.eventTimes.find((t) => t > this.time + 1e-4);
    this.seek(next ?? this.duration);
  }

  stepBack(): void {
    const prev = [...this.eventTimes].reverse().find((t) => t < this.time - 1e-4);
    this.seek(prev ?? 0);
  }

  private tick = (ts: number): void => {
    if (!this.playing) return;
    const dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    this.time += dt * this.speed;
    if (this.time >= this.duration) {
      if (this.loop && this.duration > 0) {
        this.time = 0;
      } else {
        this.time = this.duration;
        this.playing = false;
      }
    }
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  };

  private frame(): Frame {
    const channels = new Map<number, ChannelFrameState>();
    if (this.schedule) {
      const sampled = sampleAt(this.schedule, this.time);
      for (const [ch, v] of sampled) {
        channels.set(ch, {
          pos: v.pos,
          sourceLine: v.sourceLine,
          waiting: v.waiting,
          segIndex: v.segIndex,
        });
      }
    }
    return {
      time: this.time,
      duration: this.duration,
      playing: this.playing,
      speed: this.speed,
      channels,
    };
  }

  private emit(): void {
    const f = this.frame();
    for (const s of this.subs) s(f);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.subs.clear();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
