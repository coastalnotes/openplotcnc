/**
 * Built-in machine templates.
 *
 * Each template is a standalone JSON file under `machines/` so it can be read,
 * copied and hand-edited outside the extension. Users load one as the starting
 * point for a job and then customise it in the Setup editor.
 */

import type { MachineTemplate, SetupConfig } from '../types';
import { normalizeSetup } from '../config/schema';
import { DEFAULT_GEOMETRY, L12VII_GEOMETRY, L12X_GEOMETRY } from '../config/geometry';

import citizenL12vii from '../../machines/citizen-l12vii.json';
import citizenL12x from '../../machines/citizen-l12x.json';
import genericSwissFanuc from '../../machines/generic-swiss-fanuc.json';
import genericLatheFanuc from '../../machines/generic-lathe-fanuc.json';

const RAW: unknown[] = [citizenL12vii, citizenL12x, genericSwissFanuc, genericLatheFanuc];

const GEOMETRY: Record<string, typeof DEFAULT_GEOMETRY> = {
  'citizen-l12x': L12X_GEOMETRY,
  'citizen-l12vii': L12VII_GEOMETRY,
};

function coerce(raw: any): MachineTemplate {
  const { setup } = normalizeSetup(raw.setup);
  setup.template = raw.id;
  setup.machine.geometry = GEOMETRY[String(raw.id)] ?? DEFAULT_GEOMETRY;
  return {
    id: String(raw.id),
    name: String(raw.name),
    vendor: String(raw.vendor ?? ''),
    summary: String(raw.summary ?? ''),
    reference: String(raw.reference ?? ''),
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    axes: Array.isArray(raw.axes) ? raw.axes.map(String) : [],
    setup,
  };
}

export const MACHINE_TEMPLATES: MachineTemplate[] = RAW.map(coerce);

export function getTemplate(id: string): MachineTemplate | undefined {
  return MACHINE_TEMPLATES.find((t) => t.id === id);
}

export function templateSetup(id: string): SetupConfig | undefined {
  const t = getTemplate(id);
  return t ? JSON.parse(JSON.stringify(t.setup)) : undefined;
}
