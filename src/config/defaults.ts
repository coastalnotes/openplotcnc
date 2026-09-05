import type { Dialect, KinematicsMode, SetupConfig } from '../types';

export const CHANNEL_COLORS = ['#22d3ee', '#f59e0b', '#e879f9', '#4ade80'];

export function defaultSetup(
  kinematicsMode: KinematicsMode = 'swiss-type',
  dialect: Dialect = 'fanuc',
  channelCount = 2
): SetupConfig {
  const channels = Array.from({ length: Math.min(Math.max(channelCount, 1), 4) }, (_, i) => ({
    id: i + 1,
    name: `Path ${i + 1}`,
    spindle: (i % 2 === 0 ? 'main' : 'sub') as 'main' | 'sub',
    color: CHANNEL_COLORS[i],
    file: `PATH${i + 1}.NC`,
    marker: `$${i + 1}`,
  }));

  return {
    version: 1,
    machine: {
      kinematicsMode,
      dialect,
      diameterMode: true,
      units: 'mm',
      guideBushingZ: 0,
      mainSpindleFaceZ: -20,
      subSpindle: {
        enabled: true,
        homeZ: 260,
        pickupZ: 40,
      },
      channels,
    },
    stock: {
      outerDiameter: 20,
      innerDiameter: 0,
      length: 300,
      protrusion: 15,
      material: 'AISI 1215',
    },
    tools: [
      {
        id: 't1-od',
        channel: 1,
        station: 'T0101',
        type: 'od-turn',
        orientation: 'main',
        noseRadius: 0.4,
        color: CHANNEL_COLORS[0],
      },
      {
        id: 't1-part',
        channel: 1,
        station: 'T0303',
        type: 'part-off',
        orientation: 'main',
        width: 2,
        color: CHANNEL_COLORS[0],
      },
      {
        id: 't2-back',
        channel: 2,
        station: 'T0505',
        type: 'od-turn',
        orientation: 'sub',
        noseRadius: 0.2,
        color: CHANNEL_COLORS[1],
      },
    ],
  };
}
