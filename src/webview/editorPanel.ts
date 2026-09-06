import * as vscode from 'vscode';
import { renderHtml } from './html';
import { assembleSingleFile, loadChannels, type ChannelSet } from './loader';
import { loadSetup, saveSetup } from './setupIo';
import { parseMultiChannel } from '../parser';
import { alignChannels } from '../channels/alignment';
import { reviewProgram } from '../validate/review';
import { MACHINE_TEMPLATES, templateSetup } from '../machines';
import { browseForProgram } from './pickers';
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
  private pendingLayout: 'split' | 'editor' | '3d' | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('openplotcnc');

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

    this.disposables.push(this.diagnostics);
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

  /** Re-read setup + channels from disk and push to the webview. */
  async reloadPublic(): Promise<void> {
    await this.reload();
  }

  setLayout(layout: 'split' | 'editor' | '3d'): void {
    this.pendingLayout = layout;
    this.post({ type: 'setLayout', layout });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
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
    this.publishDiagnostics();
  }

  /** Publish the program review to the VS Code Problems panel. */
  private publishDiagnostics(): void {
    const program = parseMultiChannel(
      this.channelSet.channels.map((c) => ({
        channel: c.id,
        name: c.name,
        source: c.text,
        uri: c.uri,
      })),
      { dialect: this.setup.machine.dialect }
    );
    const review = reviewProgram(program);

    const byUri = new Map<string, vscode.Diagnostic[]>();
    const put = (uri: string, d: vscode.Diagnostic) => {
      if (!byUri.has(uri)) byUri.set(uri, []);
      byUri.get(uri)!.push(d);
    };

    for (const f of review.findings) {
      const ch = this.channelSet.channels.find((c) => c.id === f.channel);
      if (!ch) continue;
      let targetUri: string | undefined;
      let srcLine = f.line;
      if (this.channelSet.mode === 'single-file') {
        targetUri = this.channelSet.sourceUri;
        srcLine = ch.sourceLines?.[f.line] ?? f.line;
      } else {
        targetUri = ch.uri;
      }
      if (!targetUri) continue;
      const sev =
        f.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : f.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(
        new vscode.Range(srcLine, 0, srcLine, 500),
        `[${ch.name}] ${f.message}`,
        sev
      );
      d.source = 'OpenPlotCNC';
      d.code = f.category;
      put(targetUri, d);
    }

    this.diagnostics.clear();
    for (const [uri, ds] of byUri) this.diagnostics.set(vscode.Uri.parse(uri), ds);
  }

  private programName(): string {
    return vscode.workspace.asRelativePath(this.primary.uri);
  }

  private async applyTemplate(id: string): Promise<void> {
    const next = templateSetup(id);
    if (!next) return;
    // Keep the channel file/marker mapping the current program already uses.
    const existing = this.setup.machine.channels;
    next.machine.channels = next.machine.channels.map((c) => ({
      ...c,
      file: existing.find((e) => e.id === c.id)?.file ?? c.file,
    }));
    this.setup = next;
    await saveSetup(this.setup, this.primary.uri);
    await this.reload();
    vscode.window.setStatusBarMessage(`OpenPlotCNC: loaded ${id}`, 2500);
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
        if (this.pendingLayout) this.post({ type: 'setLayout', layout: this.pendingLayout });
        break;
      case 'requestChannels':
        await this.reload();
        break;
      case 'pickProgram': {
        const picked = await browseForProgram(this.primary.uri);
        if (picked) {
          this.primary = await vscode.workspace.openTextDocument(picked);
          await this.reload();
        }
        break;
      }
      case 'pickMachine': {
        const pick = await vscode.window.showQuickPick(
          MACHINE_TEMPLATES.map((t) => ({
            label: t.name,
            description: t.vendor,
            detail: t.summary,
            id: t.id,
          })),
          { title: 'Load a machine template', matchOnDetail: true }
        );
        if (pick) await this.applyTemplate(pick.id);
        break;
      }
      case 'loadMachine':
        await this.applyTemplate(msg.templateId);
        break;
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

    if (this.channelSet.mode === 'single-file') {
      // Re-split so the source-line map (used for Problems) tracks the edit.
      this.channelSet = await loadChannels(this.primary, this.setup);
    }
    this.publishDiagnostics();
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
    this.publishDiagnostics();
  }

  dispose(): void {
    BackplotterPanel.current = undefined;
    if (this.editTimer) clearTimeout(this.editTimer);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
