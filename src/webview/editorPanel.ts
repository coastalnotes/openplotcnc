import * as vscode from 'vscode';
import { renderHtml } from './html';
import { assembleSingleFile, loadChannels, type ChannelSet } from './loader';
import { loadSetup, saveSetup } from './setupIo';
import { parseMultiChannel } from '../parser';
import { alignChannels } from '../channels/alignment';
import type {
  ChannelPayload,
  HostToWebview,
  SetupConfig,
  WebviewToHost,
} from '../types';

const VIEW_TYPE = 'openplotcnc.backplotter';

function themeKind(): 'light' | 'dark' {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

export class BackplotterPanel {
  static current: BackplotterPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private setup: SetupConfig;
  private channelSet: ChannelSet;
  private primary: vscode.TextDocument;
  private applyingRemoteEdit = false;
  private editTimer: NodeJS.Timeout | undefined;
  private pendingEdits = new Map<number, string>();

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    primary: vscode.TextDocument,
    setup: SetupConfig,
    channelSet: ChannelSet
  ) {
    this.panel = panel;
    this.primary = primary;
    this.setup = setup;
    this.channelSet = channelSet;

    this.panel.webview.html = renderHtml(this.panel.webview, this.context.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m: WebviewToHost) => this.onMessage(m),
      null,
      this.disposables
    );

    vscode.workspace.onDidChangeTextDocument(
      (e) => this.onDocChanged(e),
      null,
      this.disposables
    );
    vscode.window.onDidChangeActiveColorTheme(
      () => this.post({ type: 'theme', theme: themeKind() }),
      null,
      this.disposables
    );
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('openplotcnc')) void this.reload();
      },
      null,
      this.disposables
    );
  }

  static async createOrShow(
    context: vscode.ExtensionContext,
    primary: vscode.TextDocument
  ): Promise<BackplotterPanel> {
    const column = vscode.ViewColumn.Beside;

    if (BackplotterPanel.current) {
      BackplotterPanel.current.panel.reveal(column);
      await BackplotterPanel.current.rebind(primary);
      return BackplotterPanel.current;
    }

    const setup = await loadSetup(primary.uri);
    const channelSet = await loadChannels(primary, setup);

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'OpenPlotCNC Backplotter',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      }
    );

    BackplotterPanel.current = new BackplotterPanel(panel, context, primary, setup, channelSet);
    return BackplotterPanel.current;
  }

  /** Re-scan channels & setup from the workspace and push to the webview. */
  async syncChannels(): Promise<void> {
    await this.reload();
    const prog = parseMultiChannel(
      this.channelSet.channels.map((c) => ({
        channel: c.id,
        name: c.name,
        source: c.text,
        uri: c.uri,
      })),
      { dialect: this.setup.machine.dialect }
    );
    const align = alignChannels(prog);
    const matched = align.barriers.filter((b) => b.matched);
    const unmatched = align.barriers.filter((b) => !b.matched);
    vscode.window.showInformationMessage(
      `OpenPlotCNC: ${this.channelSet.channels.length} channel(s), ` +
        `${matched.length} sync barrier(s) aligned` +
        (unmatched.length ? `, ${unmatched.length} unmatched` : '')
    );
  }

  openConfig(): void {
    this.post({ type: 'setup', setup: this.setup });
    this.post({ type: 'openConfig' });
  }

  private async rebind(primary: vscode.TextDocument): Promise<void> {
    this.primary = primary;
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.setup = await loadSetup(this.primary.uri);
    this.channelSet = await loadChannels(this.primary, this.setup);
    this.post({
      type: 'init',
      setup: this.setup,
      channels: this.payload(),
      subprograms: this.channelSet.subprograms,
      program: this.programName(),
      mode: this.channelSet.mode,
      theme: themeKind(),
    });
  }

  private programName(): string {
    return vscode.workspace.asRelativePath(this.primary.uri);
  }

  private payload(): ChannelPayload[] {
    return this.channelSet.channels.map((c) => ({
      id: c.id,
      name: c.name,
      text: c.text,
      uri: c.uri,
    }));
  }

  private post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          setup: this.setup,
          channels: this.payload(),
          subprograms: this.channelSet.subprograms,
          program: this.programName(),
          mode: this.channelSet.mode,
          theme: themeKind(),
        });
        break;
      case 'requestChannels':
        await this.reload();
        break;
      case 'pickProgram': {
        const uris = await vscode.workspace.findFiles(
          '**/*.{nc,NC,cnc,CNC,gcode,g,mpf,MPF,ngc,tap,TAP,eia,EIA,min,MIN,pim,PIM,prg,PRG,sub,SUB,mpr,MPR}',
          '**/node_modules/**',
          200
        );
        const pick = await vscode.window.showQuickPick(
          uris
            .map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u }))
            .sort((a, b) => a.label.localeCompare(b.label)),
          { title: 'Select the CNC program to load' }
        );
        if (pick) {
          this.primary = await vscode.workspace.openTextDocument(pick.uri);
          await this.reload();
        }
        break;
      }
      case 'edit':
        this.pendingEdits.set(msg.channel, msg.text);
        this.scheduleWriteBack();
        break;
      case 'cursor': {
        const ch = this.channelSet.channels.find((c) => c.id === msg.channel);
        if (ch?.uri) {
          const uri = vscode.Uri.parse(ch.uri);
          const editor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === ch.uri
          );
          if (editor) {
            const pos = new vscode.Position(Math.max(0, msg.line), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
          } else {
            void uri;
          }
        }
        break;
      }
      case 'openConfig':
        this.openConfig();
        break;
      case 'saveSetup': {
        this.setup = msg.setup;
        const uri = await saveSetup(this.setup, this.primary.uri);
        if (uri) {
          vscode.window.setStatusBarMessage('OpenPlotCNC: setup saved', 2000);
        }
        this.post({ type: 'setup', setup: this.setup });
        break;
      }
      case 'log':
        console[msg.level]?.(`[webview] ${msg.message}`);
        break;
    }
  }

  private scheduleWriteBack(): void {
    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => void this.flushWriteBack(), 400);
  }

  private async flushWriteBack(): Promise<void> {
    if (this.pendingEdits.size === 0) return;
    const edits = this.pendingEdits;
    this.pendingEdits = new Map();
    this.applyingRemoteEdit = true;
    try {
      for (const [id, text] of edits) {
        const ch = this.channelSet.channels.find((c) => c.id === id);
        if (!ch) continue;
        ch.text = text;
      }

      const wsEdit = new vscode.WorkspaceEdit();

      if (this.channelSet.mode === 'single-file' && this.channelSet.sourceUri) {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(this.channelSet.sourceUri)
        );
        const full = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        wsEdit.replace(
          doc.uri,
          full,
          assembleSingleFile(this.channelSet.channels, this.channelSet.trailer)
        );
      } else {
        for (const [id] of edits) {
          const ch = this.channelSet.channels.find((c) => c.id === id);
          if (!ch?.uri) continue;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(ch.uri));
          const full = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
          );
          wsEdit.replace(doc.uri, full, ch.text);
        }
      }

      await vscode.workspace.applyEdit(wsEdit);
    } finally {
      this.applyingRemoteEdit = false;
    }
  }

  private onDocChanged(e: vscode.TextDocumentChangeEvent): void {
    if (this.applyingRemoteEdit) return;
    const uri = e.document.uri.toString();
    const touched =
      uri === this.channelSet.sourceUri ||
      this.channelSet.channels.some((c) => c.uri === uri);
    if (!touched) return;

    if (this.channelSet.mode === 'single-file' && uri === this.channelSet.sourceUri) {
      void this.reload();
      return;
    }
    for (const c of this.channelSet.channels) {
      if (c.uri === uri) c.text = e.document.getText();
    }
    this.post({
      type: 'channels',
      channels: this.payload(),
      subprograms: this.channelSet.subprograms,
      program: this.programName(),
      mode: this.channelSet.mode,
    });
  }

  dispose(): void {
    BackplotterPanel.current = undefined;
    if (this.editTimer) clearTimeout(this.editTimer);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
