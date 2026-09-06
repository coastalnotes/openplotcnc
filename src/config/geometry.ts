/**
 * Machine geometry presets for the 3D viewport.
 *
 * Dimensions are taken from Citizen's published brochures where available:
 *   - L12-X: max machining Ø 12 mm (16 opt), spindle through-hole 20 mm,
 *     max machining length 135 mm/chucking (GB) / 30 mm (GBL), sub-spindle
 *     max protrusion 80 mm, machine envelope W1840 × D970 × H1710, centre
 *     height 1050 mm, main spindle 15 000 min⁻¹ (GB), sub 12 000 min⁻¹,
 *     rapid 32 m/min (Y2 8 m/min), FC096 main collet / F25 sub collet,
 *     WFG541-M guide bushing, 38 tools (5 gang turning + up to 17 rotary,
 *     back tool post 4 fixed + 4 rotary).
 *   Axis strokes are not published individually and are representative.
 */

import type { MachineGeometry } from '../types';

/** Neutral generic Swiss machine. */
export const DEFAULT_GEOMETRY: MachineGeometry = {
  model: 'Generic Swiss',
  base: { width: 520, depth: 420, height: 260 },
  guideBushing: { present: true, outerDiameter: 34, holderWidth: 46, holderHeight: 120 },
  mainSpindle: {
    bodyLength: 220,
    bodyDiameter: 90,
    noseLength: 26,
    z1Stroke: 210,
    maxRpm: 12000,
    collet: 'collet',
  },
  subSpindle: {
    bodyLength: 150,
    bodyDiameter: 80,
    noseLength: 22,
    z2Stroke: 210,
    x2Stroke: 95,
    y2Stroke: 40,
    maxRpm: 10000,
    collet: 'collet',
  },
  gangPost: {
    plateWidth: 150,
    plateHeight: 120,
    plateThickness: 26,
    x1Stroke: 110,
    y1Stroke: 60,
    turningStations: 5,
    liveStations: 4,
    faceZ: 0,
    parkClearance: 24,
  },
  backPost: { present: true, plateWidth: 120, plateHeight: 90, fixedStations: 4, rotaryStations: 4 },
};

/** Citizen Cincom L12-X (L12 Type X). */
export const L12X_GEOMETRY: MachineGeometry = {
  model: 'Citizen Cincom L12-X',
  base: { width: 560, depth: 430, height: 300 },
  guideBushing: { present: true, outerDiameter: 30, holderWidth: 44, holderHeight: 130 },
  mainSpindle: {
    bodyLength: 240,
    bodyDiameter: 96, // through-hole 20 mm, FC096 collet housing
    noseLength: 24,
    z1Stroke: 205, // ~ max machining length 135 + bushing gap + overtravel
    maxRpm: 15000,
    collet: 'FC096-M',
  },
  subSpindle: {
    bodyLength: 150,
    bodyDiameter: 78,
    noseLength: 20,
    z2Stroke: 205,
    x2Stroke: 90,
    y2Stroke: 40, // Type X only, rapid 8 m/min
    maxRpm: 12000,
    collet: 'F25',
  },
  gangPost: {
    plateWidth: 160,
    plateHeight: 130,
    plateThickness: 24,
    x1Stroke: 110,
    y1Stroke: 60,
    turningStations: 5, // + up to 17 rotary
    liveStations: 5,
    faceZ: 0,
    parkClearance: 22,
  },
  backPost: {
    present: true,
    plateWidth: 130,
    plateHeight: 100,
    fixedStations: 4,
    rotaryStations: 4,
  },
};

/** Citizen Cincom L12-VII (no Y2 axis on the back station). */
export const L12VII_GEOMETRY: MachineGeometry = {
  ...L12X_GEOMETRY,
  model: 'Citizen Cincom L12-VII',
  subSpindle: { ...L12X_GEOMETRY.subSpindle, y2Stroke: 0 },
  gangPost: { ...L12X_GEOMETRY.gangPost, liveStations: 4 },
  backPost: { ...L12X_GEOMETRY.backPost, rotaryStations: 4, fixedStations: 4 },
};

const N = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);

/** Best-effort coercion of a loosely-typed geometry object. */
export function normalizeGeometry(input: unknown): MachineGeometry {
  if (!input || typeof input !== 'object') return DEFAULT_GEOMETRY;
  const g = input as any;
  const d = DEFAULT_GEOMETRY;
  return {
    model: typeof g.model === 'string' ? g.model : d.model,
    base: {
      width: N(g.base?.width, d.base.width),
      depth: N(g.base?.depth, d.base.depth),
      height: N(g.base?.height, d.base.height),
    },
    guideBushing: {
      present: g.guideBushing?.present ?? d.guideBushing.present,
      outerDiameter: N(g.guideBushing?.outerDiameter, d.guideBushing.outerDiameter),
      holderWidth: N(g.guideBushing?.holderWidth, d.guideBushing.holderWidth),
      holderHeight: N(g.guideBushing?.holderHeight, d.guideBushing.holderHeight),
    },
    mainSpindle: {
      bodyLength: N(g.mainSpindle?.bodyLength, d.mainSpindle.bodyLength),
      bodyDiameter: N(g.mainSpindle?.bodyDiameter, d.mainSpindle.bodyDiameter),
      noseLength: N(g.mainSpindle?.noseLength, d.mainSpindle.noseLength),
      z1Stroke: N(g.mainSpindle?.z1Stroke, d.mainSpindle.z1Stroke),
      maxRpm: N(g.mainSpindle?.maxRpm, d.mainSpindle.maxRpm),
      collet: typeof g.mainSpindle?.collet === 'string' ? g.mainSpindle.collet : d.mainSpindle.collet,
    },
    subSpindle: {
      bodyLength: N(g.subSpindle?.bodyLength, d.subSpindle.bodyLength),
      bodyDiameter: N(g.subSpindle?.bodyDiameter, d.subSpindle.bodyDiameter),
      noseLength: N(g.subSpindle?.noseLength, d.subSpindle.noseLength),
      z2Stroke: N(g.subSpindle?.z2Stroke, d.subSpindle.z2Stroke),
      x2Stroke: N(g.subSpindle?.x2Stroke, d.subSpindle.x2Stroke),
      y2Stroke: N(g.subSpindle?.y2Stroke, d.subSpindle.y2Stroke),
      maxRpm: N(g.subSpindle?.maxRpm, d.subSpindle.maxRpm),
      collet: typeof g.subSpindle?.collet === 'string' ? g.subSpindle.collet : d.subSpindle.collet,
    },
    gangPost: {
      plateWidth: N(g.gangPost?.plateWidth, d.gangPost.plateWidth),
      plateHeight: N(g.gangPost?.plateHeight, d.gangPost.plateHeight),
      plateThickness: N(g.gangPost?.plateThickness, d.gangPost.plateThickness),
      x1Stroke: N(g.gangPost?.x1Stroke, d.gangPost.x1Stroke),
      y1Stroke: N(g.gangPost?.y1Stroke, d.gangPost.y1Stroke),
      turningStations: N(g.gangPost?.turningStations, d.gangPost.turningStations),
      liveStations: N(g.gangPost?.liveStations, d.gangPost.liveStations),
      faceZ: N(g.gangPost?.faceZ, d.gangPost.faceZ),
      parkClearance: N(g.gangPost?.parkClearance, d.gangPost.parkClearance),
    },
    backPost: {
      present: g.backPost?.present ?? d.backPost.present,
      plateWidth: N(g.backPost?.plateWidth, d.backPost.plateWidth),
      plateHeight: N(g.backPost?.plateHeight, d.backPost.plateHeight),
      fixedStations: N(g.backPost?.fixedStations, d.backPost.fixedStations),
      rotaryStations: N(g.backPost?.rotaryStations, d.backPost.rotaryStations),
    },
  };
}
