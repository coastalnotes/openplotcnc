import * as vscode from 'vscode';

const GCODE_EXTS = [
  'nc', 'NC', 'cnc', 'CNC', 'gcode', 'g', 'mpf', 'MPF', 'ngc', 'tap', 'TAP',
  'eia', 'EIA', 'min', 'MIN', 'pim', 'PIM', 'prg', 'PRG', 'sub', 'SUB', 'mpr', 'MPR',
  'gc', 'GC', 'dnc', 'DNC', 'ecs', 'fnc', 'cn1',
];

function startDir(hint?: vscode.Uri): vscode.Uri | undefined {
  if (hint) return vscode.Uri.joinPath(hint, '..');
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Native file browser for picking a CNC program (can be anywhere on disk). */
export async function browseForProgram(hint?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Load program',
    title: 'Select a CNC program',
    defaultUri: startDir(hint),
    filters: { 'G-code programs': GCODE_EXTS, 'All files': ['*'] },
  });
  return picked?.[0];
}

/** Native folder browser + open it as the workspace. */
export async function browseForFolder(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open folder',
    title: 'Open the folder that holds your NC programs',
    defaultUri: startDir(),
  });
  if (picked?.[0]) {
    await vscode.commands.executeCommand('vscode.openFolder', picked[0], { forceNewWindow: false });
  }
}
