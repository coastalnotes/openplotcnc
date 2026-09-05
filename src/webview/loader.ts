import * as vscode from 'vscode';
import { splitChannels } from '../parser';
import type { SetupConfig } from '../types';

export interface LoadedChannel {
  id: number;
  name: string;
  text: string;
  /** Underlying document (multi-file mode). */
  uri?: string;
  /** Section marker (single-file mode). */
  marker?: string;
}

export interface ChannelSet {
  mode: 'multi-file' | 'single-file';
  /** The physical document in single-file mode. */
  sourceUri?: string;
  channels: LoadedChannel[];
}

function channelName(setup: SetupConfig, id: number): string {
  return setup.machine.channels.find((c) => c.id === id)?.name ?? `Path ${id}`;
}

/** A file is "single-file multi-channel" only when >= 2 distinct markers appear. */
function looksMultiChannel(text: string, markerList: string[]): boolean {
  let hits = 0;
  for (const m of markerList) {
    const re = new RegExp('^\\s*' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'm');
    if (re.test(text)) hits++;
  }
  return hits >= 2;
}

/**
 * Resolve up to 4 channels for the backplotter, starting from `primary`.
 *
 * - If `primary` contains `$1`..`$4` (or `O1001`..) section markers, it is a
 *   single-file multi-channel program and is split in place.
 * - Otherwise `primary` is channel 1 and sibling files (from setup or the
 *   `openplotcnc.channels.fileGlobs` setting) fill channels 2..N.
 */
export async function loadChannels(
  primary: vscode.TextDocument,
  setup: SetupConfig
): Promise<ChannelSet> {
  const text = primary.getText();
  const markers = setup.machine.channels.map((c) => c.marker).filter(Boolean) as string[];
  const markerList = markers.length ? markers : ['$1', '$2', '$3', '$4'];

  if (looksMultiChannel(text, markerList)) {
    const split = splitChannels(text, markerList);
    const channels: LoadedChannel[] = [];
    for (const [id, chunk] of [...split.entries()].sort((a, b) => a[0] - b[0])) {
      channels.push({
        id,
        name: channelName(setup, id),
        text: chunk,
        marker: markerList[id - 1] ?? `$${id}`,
      });
    }
    return { mode: 'single-file', sourceUri: primary.uri.toString(), channels };
  }

  // Multi-file: primary + siblings.
  const channels: LoadedChannel[] = [
    { id: 1, name: channelName(setup, 1), text, uri: primary.uri.toString() },
  ];

  const dir = vscode.Uri.joinPath(primary.uri, '..');
  const cfgFiles = setup.machine.channels
    .map((c) => c.file)
    .filter(Boolean) as string[];
  const globFiles =
    cfgFiles.length > 1
      ? cfgFiles
      : (vscode.workspace
          .getConfiguration('openplotcnc')
          .get<string[]>('channels.fileGlobs') ?? ['PATH1.NC', 'PATH2.NC', 'PATH3.NC', 'PATH4.NC']);

  const count = vscode.workspace
    .getConfiguration('openplotcnc')
    .get<number>('channels.count', setup.machine.channels.length || 2);

  for (let id = 2; id <= Math.min(count, 4); id++) {
    const candidate = globFiles[id - 1];
    if (!candidate) continue;
    const uri = vscode.Uri.joinPath(dir, candidate);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      channels.push({ id, name: channelName(setup, id), text: doc.getText(), uri: uri.toString() });
    } catch {
      // sibling not present — that channel simply isn't loaded
    }
  }

  return { mode: 'multi-file', channels };
}

/** Rebuild a single-file document from edited channel texts. */
export function assembleSingleFile(channels: LoadedChannel[]): string {
  return channels
    .sort((a, b) => a.id - b.id)
    .map((c) => `${c.marker ?? `$${c.id}`}\n${c.text.replace(/\s+$/, '')}\n`)
    .join('');
}
