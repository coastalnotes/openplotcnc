import * as THREE from 'three';
import type { ScheduledChannel, ScheduledSegment } from '../../src/simulation/timeline';
import type { Vec3 } from '../../src/types';

/** engine world (x=radial, y=lateral, z=axial) -> three.js (x=axial, y=up/radial, z=lateral) */
export function toThree(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.z, p.x, p.y);
}

const CHANNEL_COLORS = [0x22d3ee, 0xf59e0b, 0xe879f9, 0x4ade80];

export interface ChannelPath {
  channel: number;
  group: THREE.Group;
  /** ordered polyline vertices (three space). */
  points: THREE.Vector3[];
  /** wall-clock time at each vertex. */
  times: number[];
  progressLine: THREE.Line;
  bounds: THREE.Box3;
}

function arcPoints(seg: ScheduledSegment): Vec3[] {
  if (!seg.center) return [seg.from, seg.to];
  const planeAxes: Record<string, [keyof Vec3, keyof Vec3, keyof Vec3]> = {
    XY: ['x', 'y', 'z'],
    ZX: ['z', 'x', 'y'],
    YZ: ['y', 'z', 'x'],
  };
  const [ua, va, wa] = planeAxes[seg.plane];
  const c = seg.center;
  const r = Math.hypot((seg.from[ua] as number) - (c[ua] as number), (seg.from[va] as number) - (c[va] as number));
  const a0 = Math.atan2((seg.from[va] as number) - (c[va] as number), (seg.from[ua] as number) - (c[ua] as number));
  let a1 = Math.atan2((seg.to[va] as number) - (c[va] as number), (seg.to[ua] as number) - (c[ua] as number));
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

export function buildChannelPath(sc: ScheduledChannel): ChannelPath {
  const color = CHANNEL_COLORS[(sc.channel - 1) % 4];
  const group = new THREE.Group();
  group.name = `channel-${sc.channel}`;

  const feedPts: number[] = [];
  const rapidPts: number[] = [];
  const poly: THREE.Vector3[] = [];
  const times: number[] = [];
  const bounds = new THREE.Box3();

  let last: THREE.Vector3 | undefined;
  for (const seg of sc.segments) {
    const raw = seg.motion.startsWith('arc') ? arcPoints(seg) : [seg.from, seg.to];
    const v = raw.map(toThree);

    for (let i = 0; i < v.length; i++) {
      bounds.expandByPoint(v[i]);
      if (i === 0) {
        if (!last || last.distanceToSquared(v[0]) > 1e-9) {
          poly.push(v[0].clone());
          times.push(seg.tStartWall);
        }
      } else {
        const a = v[i - 1];
        const b = v[i];
        const target = seg.rapid ? rapidPts : feedPts;
        target.push(a.x, a.y, a.z, b.x, b.y, b.z);
        poly.push(b.clone());
        const f = v.length > 2 ? i / (v.length - 1) : 1;
        times.push(seg.tStartWall + (seg.tEndWall - seg.tStartWall) * f);
      }
    }
    last = v[v.length - 1];
  }

  if (feedPts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(feedPts, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
  }
  if (rapidPts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(rapidPts, 3));
    const m = new THREE.LineDashedMaterial({ color, dashSize: 1.4, gapSize: 0.9, opacity: 0.55, transparent: true });
    const seg = new THREE.LineSegments(g, m);
    seg.computeLineDistances();
    group.add(seg);
  }

  const progGeom = new THREE.BufferGeometry();
  if (poly.length) progGeom.setFromPoints(poly);
  const progressLine = new THREE.Line(
    progGeom,
    new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })
  );
  progressLine.geometry.setDrawRange(0, 0);
  group.add(progressLine);

  return { channel: sc.channel, group, points: poly, times, progressLine, bounds };
}

/** Number of polyline vertices reached by wall-clock time `t`. */
export function progressCount(path: ChannelPath, t: number): number {
  const { times } = path;
  if (times.length === 0) return 0;
  if (t >= times[times.length - 1]) return times.length;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
