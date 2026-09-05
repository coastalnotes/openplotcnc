import * as vscode from 'vscode';
import { BackplotterPanel } from './webview/editorPanel';
import { loadSetup, saveSetup } from './webview/setupIo';
import { defaultSetup } from './config/defaults';

async function pickGcodeDocument(): Promise<vscode.TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && (active.languageId === 'gcode' || /\.(nc|cnc|gcode|mpf|min|pim|eia|tap)$/i.test(active.fileName))) {
    return active;
  }
  const picks = await vscode.workspace.findFiles('**/*.{nc,NC,cnc,gcode,mpf,min,pim}', '**/node_modules/**', 20);
  if (picks.length === 0) {
    void vscode.window.showErrorMessage('OpenPlotCNC: no G-code file found. Open a .nc file first.');
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    picks.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
    { title: 'Select the primary channel program' }
  );
  return choice ? vscode.workspace.openTextDocument(choice.uri) : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('openplotcnc.openBackplotter', async () => {
      const doc = await pickGcodeDocument();
      if (!doc) return;
      await BackplotterPanel.createOrShow(context, doc);
    }),

    vscode.commands.registerCommand('openplotcnc.syncChannels', async () => {
      if (!BackplotterPanel.current) {
        const doc = await pickGcodeDocument();
        if (!doc) return;
        await BackplotterPanel.createOrShow(context, doc);
      }
      await BackplotterPanel.current?.syncChannels();
    }),

    vscode.commands.registerCommand('openplotcnc.configureTooling', async () => {
      if (!BackplotterPanel.current) {
        const doc = await pickGcodeDocument();
        if (doc) await BackplotterPanel.createOrShow(context, doc);
      }
      if (BackplotterPanel.current) {
        BackplotterPanel.current.openConfig();
        return;
      }
      // No panel / no document — still let the user scaffold a setup file.
      const existing = await loadSetup();
      const seed = existing ?? defaultSetup();
      const uri = await saveSetup(seed);
      if (uri) {
        const d = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(d);
      }
    })
  );
}

export function deactivate(): void {
  BackplotterPanel.current?.dispose();
}
