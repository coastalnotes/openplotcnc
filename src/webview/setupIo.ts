import * as vscode from 'vscode';
import { defaultSetup } from '../config/defaults';
import { normalizeSetup } from '../config/schema';
import type { Dialect, KinematicsMode, SetupConfig } from '../types';

export const SETUP_FILE = 'openplotcnc.setup.json';

function workspaceRoot(hint?: vscode.Uri): vscode.Uri | undefined {
  if (hint) {
    const f = vscode.workspace.getWorkspaceFolder(hint);
    if (f) return f.uri;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export async function loadSetup(hint?: vscode.Uri): Promise<SetupConfig> {
  const cfg = vscode.workspace.getConfiguration('openplotcnc');
  const km = cfg.get<KinematicsMode>('machine.kinematicsMode', 'swiss-type');
  const dialect = cfg.get<Dialect>('machine.dialect', 'fanuc');
  const count = cfg.get<number>('channels.count', 2);

  const root = workspaceRoot(hint);
  if (root) {
    const uri = vscode.Uri.joinPath(root, SETUP_FILE);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const { setup } = normalizeSetup(parsed);
      return setup;
    } catch {
      // fall through to defaults
    }
  }
  return defaultSetup(km, dialect, count);
}

export async function saveSetup(setup: SetupConfig, hint?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const root = workspaceRoot(hint);
  if (!root) {
    void vscode.window.showWarningMessage(
      'OpenPlotCNC: open a folder to persist the machine setup.'
    );
    return undefined;
  }
  const uri = vscode.Uri.joinPath(root, SETUP_FILE);
  const body = JSON.stringify(setup, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
  return uri;
}
