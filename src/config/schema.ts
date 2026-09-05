/**
 * JSON-schema for `openplotcnc.setup.json` and a runtime validator/normaliser
 * used by the configuration UI and by the file loader.
 */

import type { SetupConfig, ToolType } from '../types';
import { defaultSetup } from './defaults';

export const SETUP_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'OpenPlotCNC Setup',
  type: 'object',
  required: ['version', 'machine', 'stock', 'tools'],
  properties: {
    version: { const: 1 },
    machine: {
      type: 'object',
      required: ['kinematicsMode', 'dialect', 'channels'],
      properties: {
        kinematicsMode: { enum: ['standard-lathe', 'swiss-type'] },
        dialect: { enum: ['fanuc', 'mitsubishi'] },
        diameterMode: { type: 'boolean' },
        units: { enum: ['mm', 'inch'] },
        guideBushingZ: { type: 'number' },
        mainSpindleFaceZ: { type: 'number' },
        subSpindle: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            homeZ: { type: 'number' },
            pickupZ: { type: 'number' },
          },
        },
        channels: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            required: ['id', 'spindle'],
            properties: {
              id: { type: 'integer', minimum: 1, maximum: 4 },
              name: { type: 'string' },
              spindle: { enum: ['main', 'sub'] },
              color: { type: 'string' },
              file: { type: 'string' },
              marker: { type: 'string' },
            },
          },
        },
      },
    },
    stock: {
      type: 'object',
      required: ['outerDiameter', 'length'],
      properties: {
        outerDiameter: { type: 'number', exclusiveMinimum: 0 },
        innerDiameter: { type: 'number', minimum: 0 },
        length: { type: 'number', exclusiveMinimum: 0 },
        protrusion: { type: 'number', minimum: 0 },
        material: { type: 'string' },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'channel', 'type'],
        properties: {
          id: { type: 'string' },
          channel: { type: 'integer', minimum: 1, maximum: 4 },
          station: { type: 'string' },
          type: {
            enum: [
              'od-turn',
              'id-bore',
              'part-off',
              'groove',
              'thread',
              'drill',
              'endmill-radial',
              'endmill-axial',
              'tap',
            ],
          },
          orientation: { enum: ['main', 'sub', 'radial', 'axial'] },
          noseRadius: { type: 'number', minimum: 0 },
          width: { type: 'number', minimum: 0 },
          diameter: { type: 'number', minimum: 0 },
          length: { type: 'number', minimum: 0 },
          color: { type: 'string' },
        },
      },
    },
  },
} as const;

const TOOL_TYPES: ToolType[] = [
  'od-turn',
  'id-bore',
  'part-off',
  'groove',
  'thread',
  'drill',
  'endmill-radial',
  'endmill-axial',
  'tap',
];

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Best-effort validation + coercion into a complete {@link SetupConfig}. */
export function normalizeSetup(input: unknown): {
  setup: SetupConfig;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const base = defaultSetup();
  if (typeof input !== 'object' || input === null) {
    issues.push({ path: '', message: 'Setup must be a JSON object; using defaults.' });
    return { setup: base, issues };
  }
  const raw = input as Record<string, any>;
  const m = raw.machine ?? {};
  const s = raw.stock ?? {};

  const num = (v: any, fallback: number, path: string): number => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v !== undefined) issues.push({ path, message: `Expected number, got ${typeof v}` });
    return fallback;
  };

  const setup: SetupConfig = {
    version: 1,
    machine: {
      kinematicsMode:
        m.kinematicsMode === 'standard-lathe' ? 'standard-lathe' : 'swiss-type',
      dialect: m.dialect === 'mitsubishi' ? 'mitsubishi' : 'fanuc',
      diameterMode: m.diameterMode ?? base.machine.diameterMode,
      units: m.units === 'inch' ? 'inch' : 'mm',
      guideBushingZ: num(m.guideBushingZ, base.machine.guideBushingZ, 'machine.guideBushingZ'),
      mainSpindleFaceZ: num(
        m.mainSpindleFaceZ,
        base.machine.mainSpindleFaceZ,
        'machine.mainSpindleFaceZ'
      ),
      subSpindle: {
        enabled: m.subSpindle?.enabled ?? base.machine.subSpindle.enabled,
        homeZ: num(m.subSpindle?.homeZ, base.machine.subSpindle.homeZ, 'machine.subSpindle.homeZ'),
        pickupZ: num(
          m.subSpindle?.pickupZ,
          base.machine.subSpindle.pickupZ,
          'machine.subSpindle.pickupZ'
        ),
      },
      channels: Array.isArray(m.channels) && m.channels.length
        ? m.channels.slice(0, 4).map((c: any, i: number) => ({
            id: Number.isInteger(c?.id) ? c.id : i + 1,
            name: typeof c?.name === 'string' ? c.name : `Path ${i + 1}`,
            spindle: c?.spindle === 'sub' ? 'sub' : 'main',
            color: typeof c?.color === 'string' ? c.color : base.machine.channels[i]?.color ?? '#22d3ee',
            file: typeof c?.file === 'string' ? c.file : undefined,
            marker: typeof c?.marker === 'string' ? c.marker : undefined,
          }))
        : base.machine.channels,
    },
    stock: {
      outerDiameter: num(s.outerDiameter, base.stock.outerDiameter, 'stock.outerDiameter'),
      innerDiameter: num(s.innerDiameter, base.stock.innerDiameter, 'stock.innerDiameter'),
      length: num(s.length, base.stock.length, 'stock.length'),
      protrusion: num(s.protrusion, base.stock.protrusion, 'stock.protrusion'),
      material: typeof s.material === 'string' ? s.material : base.stock.material,
    },
    tools: Array.isArray(raw.tools)
      ? raw.tools.map((t: any, i: number) => ({
          id: typeof t?.id === 'string' ? t.id : `tool-${i + 1}`,
          channel: Number.isInteger(t?.channel) ? t.channel : 1,
          station: typeof t?.station === 'string' ? t.station : '',
          type: TOOL_TYPES.includes(t?.type) ? t.type : 'od-turn',
          orientation: ['main', 'sub', 'radial', 'axial'].includes(t?.orientation)
            ? t.orientation
            : 'main',
          noseRadius: typeof t?.noseRadius === 'number' ? t.noseRadius : undefined,
          width: typeof t?.width === 'number' ? t.width : undefined,
          diameter: typeof t?.diameter === 'number' ? t.diameter : undefined,
          length: typeof t?.length === 'number' ? t.length : undefined,
          color: typeof t?.color === 'string' ? t.color : undefined,
        }))
      : base.tools,
  };

  if (setup.stock.innerDiameter >= setup.stock.outerDiameter) {
    issues.push({
      path: 'stock.innerDiameter',
      message: 'Inner diameter must be smaller than outer diameter; clamped.',
    });
    setup.stock.innerDiameter = 0;
  }

  return { setup, issues };
}
