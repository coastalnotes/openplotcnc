import type { ScheduledChannel, ScheduledSegment } from '../../src/simulation/timeline';
import type { SetupConfig, Vec3 } from '../../src/types';

const CHANNEL_COLORS = ['#22d3ee', '#f59e0b', '#e879f9', '#4ade80'];

interface P2 {
  z: number;
  x: number;
}

interface Stroke {
  pts: P2[];
  times: number[];
  rapid: boolean;
}

interface ChannelPlot {
  channel: number;
  strokes: Stroke[];
}

/** Expand arcs in full 3D, then project to the Z–X turning plane. */
function arcPoints(seg: ScheduledSegment): Vec3[] {
  if (!seg.center) return [seg.from, seg.to];
  const planeAxes: Record<string, [keyof Vec3, keyof Vec3, keyof Vec3]> = {
    XY: ['x', 'y', 'z'],
    ZX: ['z', 'x', 'y'],
    YZ: ['y', 'z', 'x'],
  };
  const [ua, va, wa] = planeAxes[seg.plane];
  const c = seg.center;
  const r = Math.hypot(
    (seg.from[ua] as number) - (c[ua] as number),
    (seg.from[va] as number) - (c[va] as number)
  );
  const a0 = Math.atan2(
    (seg.from[va] as number) - (c[va] as number),
    (seg.from[ua] as number) - (c[ua] as number)
  );
  let a1 = Math.atan2(
    (seg.to[va] as number) - (c[va] as number),
    (seg.to[ua] as number) - (c[ua] as number)
  );
  const ccw = seg.motion === 'arc-ccw';
  if (ccw && a1 <= a0) a1 += Math.PI * 2;
  if (!ccw && a1 >= a0) a1 -= Math.PI * 2;
  const sweep = a1 - a0;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 48)));
  const w0 = seg.from[wa] as number;
  const w1 = seg.to[wa] as number;
  const pts: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const ang = a0 + sweep * f;
    const p: any = {};
    p[ua] = (c[ua] as number) + r * Math.cos(ang);
    p[va] = (c[va] as number) + r * Math.sin(ang);
    p[wa] = w0 + (w1 - w0) * f;
    pts.push({ x: p.x, y: p.y, z: p.z });
  }
  return pts;
}

/**
 * Lightweight 2D turning plot (Z horizontal, X vertical).
 *
 * Replaces the Three.js scene: no dependencies, draws feed moves solid,
 * rapids dashed, with per-channel progress + tool markers driven by the
 * same wall-clock animator.
 */
export class Plot2D {
  private readonly ctx: CanvasRenderingContext2D;
  private channels: ChannelPlot[] = [];
  private setup: SetupConfig | undefined;
  private theme: 'light' | 'dark' = 'dark';
  private rapidsVisible = true;
  private gridVisible = true;
  private time = 0;
  private positions = new Map<number, { pos: Vec3; waiting: boolean }>();
  private bounds: { minZ: number; maxZ: number; minX: number; maxX: number } | undefined;
  private view: { scale: number; ox: number; oy: number } = { scale: 1, ox: 0, oy: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.theme = theme;
    this.draw();
  }

  setSetup(setup: SetupConfig): void {
    this.setup = setup;
    this.draw();
  }

  setToolpaths(channels: ScheduledChannel[]): void {
    this.channels = channels.map((sc) => {
      const strokes: Stroke[] = [];
      for (const seg of sc.segments) {
        const raw = seg.motion.startsWith('arc') ? arcPoints(seg) : [seg.from, seg.to];
        const pts = raw.map((p) => ({ z: p.z, x: p.x }));
        const times = raw.map((_, i) => {
          const f = raw.length > 2 ? i / (raw.length - 1) : i === 0 ? 0 : 1;
          return seg.tStartWall + (seg.tEndWall - seg.tStartWall) * f;
        });
        // Skip zero-length dwells with a single repeated point.
        if (pts.length === 2 && pts[0].z === pts[1].z && pts[0].x === pts[1].x) continue;
        strokes.push({ pts, times, rapid: seg.rapid });
      }
      return { channel: sc.channel, strokes };
    });
    this.computeBounds();
    this.frameAll(false);
    this.draw();
  }

  clearToolpaths(): void {
    this.channels = [];
    this.bounds = undefined;
    this.time = 0;
    this.positions.clear();
    this.draw();
  }

  get hasToolpaths(): boolean {
    return this.channels.length > 0;
  }

  setRapidsVisible(visible: boolean): void {
    this.rapidsVisible = visible;
    this.draw();
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    this.draw();
  }

  frameAll(redraw = true): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    const b = this.bounds;
    if (!b || w < 2 || h < 2) {
      this.view = { scale: 1, ox: w / 2, oy: h / 2 };
      if (redraw) this.draw();
      return;
    }
    const pad = 48;
    const spanZ = Math.max(b.maxZ - b.minZ, 1e-6);
    const spanX = Math.max(b.maxX - b.minX, 1e-6);
    const scale = Math.min((w - pad * 2) / spanZ, (h - pad * 2) / spanX);
    // World -> screen: sx = ox + z * scale, sy = oy - x * scale.
    const ox = pad + (w - pad * 2 - spanZ * scale) / 2 - b.minZ * scale;
    const oy = pad + (h - pad * 2 - spanX * scale) / 2 + b.maxX * scale;
    this.view = { scale, ox, oy };
    if (redraw) this.draw();
  }

  updatePlayback(
    time: number,
    positions: Map<number, { pos: Vec3; waiting: boolean }>
  ): void {
    this.time = time;
    this.positions = positions;
    this.draw();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.frameAll(false);
    this.draw();
  }

  dispose(): void {
    this.channels = [];
    this.positions.clear();
  }

  private computeBounds(): void {
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const ch of this.channels) {
      for (const s of ch.strokes) {
        for (const p of s.pts) {
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
        }
      }
    }
    // Always include the spindle centreline so small parts stay framed.
    if (minX === Infinity) {
      this.bounds = undefined;
      return;
    }
    minX = Math.min(minX, 0);
    maxX = Math.max(maxX, 0);
    const padZ = Math.max((maxZ - minZ) * 0.05, 2);
    const padX = Math.max((maxX - minX) * 0.08, 2);
    this.bounds = { minZ: minZ - padZ, maxZ: maxZ + padZ, minX: minX - padX, maxX: maxX + padX };
  }

  private toScreen(p: P2): [number, number] {
    return [this.view.ox + p.z * this.view.scale, this.view.oy - p.x * this.view.scale];
  }

  private draw(): void {
    const { ctx } = this;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    ctx.clearRect(0, 0, w, h);
    if (this.gridVisible) this.drawGrid(w, h);
    if (this.channels.length === 0) return;

    for (const ch of this.channels) {
      const color = CHANNEL_COLORS[(ch.channel - 1) % CHANNEL_COLORS.length];
      for (const s of ch.strokes) {
        if (s.rapid && !this.rapidsVisible) continue;
        // Full path, faint.
        this.strokePath(s.pts, color, s.rapid, s.rapid ? 0.35 : 0.4, this.timeCovered(s) <= 0);
        // Progress overlay up to current time.
        const n = this.progressCount(s, this.time);
        if (n >= 2) {
          this.strokePath(s.pts.slice(0, n), color, false, 1, false, 2);
        }
      }
    }

    // Tool markers.
    for (const ch of this.channels) {
      const st = this.positions.get(ch.channel);
      if (!st) continue;
      const color = CHANNEL_COLORS[(ch.channel - 1) % CHANNEL_COLORS.length];
      const [sx, sy] = this.toScreen({ z: st.pos.z, x: st.pos.x });
      ctx.beginPath();
      ctx.arc(sx, sy, st.waiting ? 4 : 5.5, 0, Math.PI * 2);
      ctx.globalAlpha = st.waiting ? 0.45 : 1;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.theme === 'light' ? '#111' : '#fff';
      ctx.stroke();
    }

    this.drawScaleNote(w, h);
  }

  private timeCovered(s: Stroke): number {
    if (s.times.length === 0) return 0;
    if (this.time <= s.times[0]) return 0;
    if (this.time >= s.times[s.times.length - 1]) return 1;
    return 0.5;
  }

  private progressCount(s: Stroke, t: number): number {
    let n = 0;
    while (n < s.times.length && s.times[n] <= t) n++;
    return n;
  }

  private strokePath(
    pts: P2[],
    color: string,
    dashed: boolean,
    alpha: number,
    _dim: boolean,
    width = 1.5
  ): void {
    if (pts.length < 2) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.restore();
  }

  private drawGrid(w: number, h: number): void {
    const { ctx } = this;
    const dark = this.theme !== 'light';
    ctx.save();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;

    const b = this.bounds;
    const spanWorld = b ? Math.max(b.maxZ - b.minZ, b.maxX - b.minX, 10) : 200;
    const targetPx = 56;
    const rawStep = spanWorld / Math.max((Math.min(w, h) / targetPx), 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => (s * this.view.scale) >= targetPx * 0.6) ?? mag * 10;

    const z0 = Math.floor((0 - this.view.ox) / (step * this.view.scale)) * step;
    const z1 = (w - this.view.ox) / this.view.scale;
    ctx.beginPath();
    for (let z = z0; z <= z1; z += step) {
      const [sx] = this.toScreen({ z, x: 0 });
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    // X lines: screen y = oy - x*scale  =>  x = (oy - sy)/scale
    const xTop = (this.view.oy - 0) / this.view.scale;
    const xBot = (this.view.oy - h) / this.view.scale;
    for (let x = Math.floor(Math.min(xTop, xBot) / step) * step; x <= Math.max(xTop, xBot); x += step) {
      const [, sy] = this.toScreen({ z: 0, x });
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // Spindle centreline (X = 0), stronger.
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.3)';
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    const [, cy] = this.toScreen({ z: 0, x: 0 });
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Guide-bushing marker in Swiss mode.
    const gb = this.setup?.machine.guideBushingZ;
    if (this.setup?.machine.kinematicsMode === 'swiss-type' && gb !== undefined && b && gb >= b.minZ && gb <= b.maxZ) {
      const [gx] = this.toScreen({ z: gb, x: 0 });
      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.6)' : 'rgba(71,85,105,0.6)';
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawScaleNote(w: number, h: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = this.theme === 'light' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.45)';
    ctx.fillText('Z →   ·   X ↑   ·   Z–X turning plane', 10, h - 10);
    void w;
    ctx.restore();
  }
}
