/**
 * In-app reference content. Dialect- and machine-aware so a user sees the codes
 * that actually apply to the control they are running.
 */

import type { Dialect, MachineTemplate } from '../types';

export interface CodeEntry {
  code: string;
  desc: string;
}

export interface HelpSection {
  id: string;
  title: string;
  body: string[];
  codes?: CodeEntry[];
}

const COMMON_CYCLES: CodeEntry[] = [
  { code: 'G00 / G01', desc: 'Rapid / linear feed move.' },
  { code: 'G02 / G03', desc: 'Clockwise / counter-clockwise arc (I,K offsets or R radius).' },
  { code: 'G17 / G18 / G19', desc: 'Plane select XY / ZX / YZ. Turning defaults to G18 (ZX).' },
  { code: 'G28', desc: 'Return to machine reference (home).' },
  { code: 'G50 / G92', desc: 'Set coordinate system / spindle speed clamp (control dependent).' },
  { code: 'G96 / G97', desc: 'Constant surface speed on / off (rpm).' },
  { code: 'G98 / G99', desc: 'Feed per minute / feed per revolution (Fanuc & Citizen).' },
];

const TURNING_CYCLES: CodeEntry[] = [
  { code: 'G71', desc: 'Stock-removal roughing cycle (turning). P/Q address the finish profile.' },
  { code: 'G72', desc: 'Stock-removal roughing cycle (facing).' },
  { code: 'G70', desc: 'Finishing pass along the G71/G72 profile.' },
  { code: 'G74 / G75', desc: 'End-face / OD peck drilling and grooving.' },
  { code: 'G76', desc: 'Multi-pass threading cycle.' },
  { code: 'G92', desc: 'Single-pass threading cycle.' },
  { code: 'G90 / G94', desc: 'Single-pass turning / facing cycle (Fanuc lathe).' },
];

const TRANSFORMS: CodeEntry[] = [
  { code: 'G12.1 / G13.1', desc: 'Polar-coordinate interpolation on / off — mill a flat face with X and C.' },
  { code: 'G07.1 Cr', desc: 'Cylindrical interpolation — unwrap C onto a cylinder of radius r for OD milling.' },
  { code: 'G40 / G41 / G42', desc: 'Cutter-radius compensation off / left / right.' },
  { code: 'G43 / G49', desc: 'Tool-length compensation on / off.' },
];

function syncSection(dialect: Dialect): HelpSection {
  if (dialect === 'citizen') {
    return {
      id: 'sync',
      title: 'Wait / line-up codes (Citizen)',
      body: [
        'Blocks prefixed with $1, $2, $3 belong to that tool system. The channels run in parallel and only pause where a line-up code tells them to.',
        'A "!" line-up code makes the listed systems wait for each other:',
        '  !L2        — wait at line-up code 2 (all active systems)',
        '  !1L2       — system 1 waits at code 2',
        '  !12L2      — systems 1 and 2 wait at code 2',
        '  !1!2L2     — same, multi-system form',
        'Queue / waiting sequence codes in the M600-M699 and G600-G699 ranges (e.g. M600, G600, G630) are also treated as rendezvous points and aligned across channels.',
        'The alignment engine pins every shared line-up / sequence code to the same row across the columns, and the simulator stalls each system there until all participants arrive.',
      ],
      codes: [
        { code: '!nLm', desc: 'System n waits at line-up code m.' },
        { code: 'M600-M699', desc: 'Queue / waiting sequence M-codes (rendezvous).' },
        { code: 'G600-G699', desc: 'Queue / waiting sequence G-codes, e.g. G600 / G630 (rendezvous).' },
        { code: 'G814 / G114', desc: 'Engage sub-spindle synchronous rotation (pick-off).' },
        { code: 'G813', desc: 'Cancel spindle synchronisation.' },
        { code: 'M80 / M88', desc: 'Sub-spindle collet / interference-check grouping.' },
      ],
    };
  }
  if (dialect === 'mitsubishi') {
    return {
      id: 'sync',
      title: 'Wait / line-up codes (Mitsubishi)',
      body: [
        'Each channel is a separate part-system. "!" line-up codes hold the channels together:',
        '  !L1 .. !Ln — line-up (wait) codes; the same number must appear in every channel that should meet there.',
        '  ! n        — bare line-up code, equivalent to !Ln.',
        'M100 is also accepted as a rendezvous. Shared codes are aligned row-for-row and the simulator stalls until all channels arrive.',
      ],
      codes: [
        { code: '!L1 .. !Ln', desc: 'Line-up / wait code shared between channels.' },
        { code: 'M100', desc: 'Rendezvous barrier.' },
        { code: 'G114.1', desc: 'Sub-spindle synchronous rotation for pick-off.' },
      ],
    };
  }
  return {
    id: 'sync',
    title: 'Wait / sync codes (Fanuc)',
    body: [
      'On a multi-path Fanuc control each path is a separate program. Waiting M-codes hold the paths together:',
      '  M100 .. M199 — waiting M-codes; the same code in two or more paths is a rendezvous.',
      '  M<code> P<mask> — wait only on the paths in the P bitmask (P3 = paths 1 and 2).',
      '  WAITCODE n — alias some post-processors emit for the same thing.',
      'The alignment engine puts every shared waiting code on the same row across the columns, and the simulator stalls each path there until all listed paths arrive.',
    ],
    codes: [
      { code: 'M100-M199', desc: 'Waiting M-code / rendezvous barrier.' },
      { code: 'M<n> P<mask>', desc: 'Wait on the paths selected by the P bitmask.' },
      { code: 'G30', desc: '2nd/3rd reference return — often the sub-spindle approach.' },
      { code: 'G140-G142', desc: 'Balanced-cut / sub-spindle control (control dependent).' },
    ],
  };
}

export function helpSections(dialect: Dialect, template?: MachineTemplate): HelpSection[] {
  const sections: HelpSection[] = [
    {
      id: 'start',
      title: 'Getting started',
      body: [
        '1. Pick your machine in the sidebar (or Setup ▸ load a template) so the kinematics, tool list and control dialect match your machine.',
        '2. Choose the CNC program to load. A single file with $1 / $2 / $3 sections is split into channels automatically; separate PATH1.NC / PATH2.NC files are linked by the workspace.',
        '3. The channels appear side-by-side with their wait codes lined up. Nothing is simulated yet.',
        '4. Press Run Backplot to build the 3D toolpath, then use the Simulate tab to step or play through it.',
      ],
    },
    {
      id: 'channels',
      title: 'How your file is split',
      body: [
        'Single-file programs are cut at each $1 / $2 / $3 marker. Each section ends at its program-end word — M99 on Citizen/Mitsubishi, M30 or M02 on others.',
        'Anything before the first $ marker (program number, safe-start block) is attached to the first channel.',
        'A $0 section holds common variables / offsets and is kept aside, not shown as a channel.',
        'O#### … M99 blocks after the channels are treated as subprograms; M98 P#### / M98 H#### calls are expanded into the backplot.',
      ],
    },
    syncSection(dialect),
    {
      id: 'moves',
      title: 'Motion & modal codes',
      body: ['The parser tracks full modal state — plane, units, distance mode, work offset, comp, feed mode — on every block.'],
      codes: COMMON_CYCLES,
    },
    {
      id: 'cycles',
      title: 'Turning canned cycles',
      body: [
        'Canned cycles are recognised and time-estimated. G71/G72 draw from the P…Q finish profile; full pass-by-pass expansion is not yet synthesised.',
      ],
      codes: TURNING_CYCLES,
    },
    {
      id: 'transforms',
      title: 'Polar / cylindrical interpolation & compensation',
      body: [
        'Under G12.1 the tool path is drawn in the face plane from X and C. Under G07.1 the C axis is wrapped onto a cylinder of the given radius.',
      ],
      codes: TRANSFORMS,
    },
    {
      id: 'kinematics',
      title: 'Swiss kinematics & the backplot',
      body: [
        'In Swiss mode the Z axis feeds bar stock through a fixed guide bushing: the main-spindle collet advances as the program cuts along the part (headstockZ = mainSpindleFaceZ − Z).',
        'The main spindle frame is X1 Z1 Y1 C1; the sub-spindle frame (X2 Z2 C2) is mirrored about the pick-off plane.',
        'Toolpaths are colour-coded per channel. Rapids are dashed, feed moves solid. Arcs use true geometry, not chords.',
        'In Standard-lathe mode the headstock is fixed and the turret moves instead.',
      ],
    },
    {
      id: 'tooling',
      title: 'Tooling',
      body: [
        'Each tool has a type (OD turn, ID bore, part-off, groove, thread, drill, radial / axial endmill, tap), an orientation (main, sub, radial, axial) and geometry (nose radius, blade width, diameter).',
        'Load a machine template for the standard station list, then adjust it in the Setup editor. Your changes are saved to openplotcnc.setup.json next to your program.',
      ],
    },
  ];

  if (template) {
    sections.push({
      id: 'machine',
      title: `${template.name} — machine notes`,
      body: [
        `${template.summary}`,
        template.axes.length ? `Controlled axes: ${template.axes.join('  ')}` : '',
        ...template.notes,
        template.reference ? `Reference: ${template.reference}` : '',
      ].filter(Boolean),
    });
  }

  return sections;
}
