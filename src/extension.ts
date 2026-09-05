import * as vscode from 'vscode';
import { BackplotterPanel } from './webview/editorPanel';
import { HomeViewProvider } from './webview/sidebarView';
import { loadSetup, saveSetup } from './webview/setupIo';
import { defaultSetup } from './config/defaults';
import { templateSetup } from './machines';

const GCODE_GLOB = '**/*.{nc,NC,cnc,CNC,gcode,g,mpf,MPF,ngc,tap,TAP,eia,EIA,min,MIN,pim,PIM,prg,PRG,sub,SUB,mpr,MPR}';

async function pickGcodeDocument(): Promise<vscode.TextDocument | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (
    active &&
    (active.languageId === 'gcode' ||
      /\.(nc|cnc|gcode|g|mpf|ngc|tap|eia|min|pim|prg|sub|mpr)$/i.test(active.fileName))
  ) {
    return active;
  }
  const picks = await vscode.workspace.findFiles(GCODE_GLOB, '**/node_modules/**', 50);
  if (picks.length === 0) {
    void vscode.window.showErrorMessage('OpenPlotCNC: no G-code file found. Open a folder with your NC programs.');
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    picks
      .map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { title: 'Select the CNC program to load' }
  );
  return choice ? vscode.workspace.openTextDocument(choice.uri) : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const home = new HomeViewProvider(
    context,
    (doc) => void BackplotterPanel.createOrShow(context, doc),
    () => {
      void (async () => {
        const doc = await home.targetDocument();
        if (doc) {
          const panel = await BackplotterPanel.createOrShow(context, doc);
          panel.openConfig();
        } else {
          await scaffoldSetup();
        }
      })();
    },
    async (id, doc) => {
      const next = templateSetup(id);
      if (!next) return;
      await saveSetup(next, doc?.uri);
      if (BackplotterPanel.current) await BackplotterPanel.current.reloadPublic();
      await home.refresh();
      vscode.window.setStatusBarMessage(`OpenPlotCNC: loaded ${id}`, 2500);
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HomeViewProvider.viewId, home, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('openplotcnc.openBackplotter', async () => {
      const doc = (await home.targetDocument()) ?? (await pickGcodeDocument());
      if (!doc) return;
      await BackplotterPanel.createOrShow(context, doc);
    }),

    vscode.commands.registerCommand('openplotcnc.splitChannels', async (arg?: vscode.Uri) => {
      const doc = arg
        ? await vscode.workspace.openTextDocument(arg)
        : (await home.targetDocument()) ?? (await pickGcodeDocument());
      if (!doc) return;
      const panel = await BackplotterPanel.createOrShow(context, doc);
      panel.setLayout('editor');
    }),

    vscode.commands.registerCommand('openplotcnc.syncChannels', async () => {
      if (!BackplotterPanel.current) {
        const doc = (await home.targetDocument()) ?? (await pickGcodeDocument());
        if (!doc) return;
        await BackplotterPanel.createOrShow(context, doc);
      }
      await BackplotterPanel.current?.syncChannels();
      await home.refresh();
    }),

    vscode.commands.registerCommand('openplotcnc.configureTooling', async () => {
      const doc = (await home.targetDocument()) ?? (await pickGcodeDocument());
      if (doc) {
        const panel = await BackplotterPanel.createOrShow(context, doc);
        panel.openConfig();
        return;
      }
      await scaffoldSetup();
    })
  );
}

async function scaffoldSetup(): Promise<void> {
  const existing = await loadSetup();
  const uri = await saveSetup(existing ?? defaultSetup());
  if (uri) {
    const d = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(d);
  }
}

export function deactivate(): void {
  BackplotterPanel.current?.dispose();
}
