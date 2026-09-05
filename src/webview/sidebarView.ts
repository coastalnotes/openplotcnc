import * as vscode from 'vscode';
import { loadChannels } from './loader';
import { loadSetup } from './setupIo';
import { parseMultiChannel } from '../parser';
import { alignChannels } from '../channels/alignment';
import { CHANNEL_COLORS } from '../config/defaults';

const GCODE_GLOB = '**/*.{nc,NC,cnc,CNC,gcode,g,mpf,MPF,ngc,tap,TAP,eia,EIA,min,MIN,pim,PIM,prg,PRG,sub,SUB,mpr,MPR}';

export interface SidebarState {
  hasWorkspace: boolean;
  program?: { name: string; uri: string };
  found: { label: string; uri: string }[];
  channels: { id: number; name: string; color: string; lines: number }[];
  mode: 'single-file' | 'multi-file' | 'none';
  syncPoints: number;
  kinematics: string;
  dialect: string;
}

function nonce(): string {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function isGcode(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === 'gcode' ||
    /\.(nc|cnc|gcode|g|mpf|ngc|tap|eia|min|pim|prg|sub|mpr)$/i.test(doc.fileName)
  );
}

/**
 * The Activity-Bar "app" panel. A compact launcher: pick a program, see the
 * channels it splits into, open the full backplotter, jump to setup.
 */
export class HomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'openplotcnc.home';

  private view: vscode.WebviewView | undefined;
  private target: vscode.Uri | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onOpenBackplotter: (doc: vscode.TextDocument) => void,
    private readonly onOpenSetup: () => void
  ) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && isGcode(e.document)) {
          this.target = e.document.uri;
          void this.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => void this.refresh())
    );
  }

  /** The program the user has selected in the sidebar (or the active editor). */
  async targetDocument(): Promise<vscode.TextDocument | undefined> {
    if (this.target) {
      try {
        return await vscode.workspace.openTextDocument(this.target);
      } catch {
        this.target = undefined;
      }
    }
    const active = vscode.window.activeTextEditor?.document;
    if (active && isGcode(active)) return active;
    return undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (m: { type: string; uri?: string }) => {
      switch (m.type) {
        case 'ready':
          void this.refresh();
          break;
        case 'choose':
          await this.chooseProgram();
          break;
        case 'pick':
          if (m.uri) {
            this.target = vscode.Uri.parse(m.uri);
            void this.refresh();
          }
          break;
        case 'open': {
          const doc = await this.targetDocument();
          if (doc) this.onOpenBackplotter(doc);
          else void this.chooseProgram();
          break;
        }
        case 'setup':
          this.onOpenSetup();
          break;
        case 'openFolder':
          void vscode.commands.executeCommand('workbench.action.files.openFolder');
          break;
      }
    });

    void this.refresh();
  }

  private async chooseProgram(): Promise<void> {
    const uris = await vscode.workspace.findFiles(GCODE_GLOB, '**/node_modules/**', 200);
    if (uris.length === 0) {
      void vscode.window.showInformationMessage('OpenPlotCNC: no NC programs found in this folder.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      uris
        .map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      { title: 'Select the CNC program to load' }
    );
    if (pick) {
      this.target = pick.uri;
      void this.refresh();
    }
  }

  private async computeState(): Promise<SidebarState> {
    const folders = vscode.workspace.workspaceFolders;
    const hasWorkspace = !!folders?.length;

    const found: { label: string; uri: string }[] = [];
    if (hasWorkspace) {
      const uris = await vscode.workspace.findFiles(GCODE_GLOB, '**/node_modules/**', 50);
      for (const u of uris.sort((a, b) => a.path.localeCompare(b.path))) {
        found.push({ label: vscode.workspace.asRelativePath(u), uri: u.toString() });
      }
    }

    const doc = await this.targetDocument();
    if (!doc) {
      return {
        hasWorkspace,
        found,
        channels: [],
        mode: 'none',
        syncPoints: 0,
        kinematics: '',
        dialect: '',
      };
    }

    const setup = await loadSetup(doc.uri);
    const set = await loadChannels(doc, setup);
    const program = parseMultiChannel(
      set.channels.map((c) => ({ channel: c.id, name: c.name, source: c.text, uri: c.uri })),
      { dialect: setup.machine.dialect }
    );
    const align = alignChannels(program);

    return {
      hasWorkspace,
      program: { name: vscode.workspace.asRelativePath(doc.uri), uri: doc.uri.toString() },
      found,
      mode: set.mode,
      channels: set.channels.map((c) => ({
        id: c.id,
        name: c.name,
        color: setup.machine.channels.find((mc) => mc.id === c.id)?.color ?? CHANNEL_COLORS[c.id - 1],
        lines: c.text.split(/\r?\n/).filter((l) => l.trim() !== '').length,
      })),
      syncPoints: align.barriers.filter((b) => b.matched).length,
      kinematics: setup.machine.kinematicsMode === 'swiss-type' ? 'Swiss-type' : 'Standard lathe',
      dialect: setup.machine.dialect === 'fanuc' ? 'Fanuc' : 'Mitsubishi',
    };
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const state = await this.computeState();
    void this.view.webview.postMessage({ type: 'state', state });
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const logo = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'openplotcnc.svg')
    );
    const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; padding: 0; margin: 0;
         color: var(--vscode-foreground); }
  .wrap { padding: 12px; display: flex; flex-direction: column; gap: 14px; }
  .hero { display: flex; align-items: center; gap: 10px; }
  .hero img { width: 26px; height: 26px; }
  .hero b { font-size: 15px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
          background: var(--vscode-editorWidget-background); padding: 10px; }
  .card h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase;
             letter-spacing: .5px; opacity: .7; }
  .prog { font-weight: 600; word-break: break-all; }
  .muted { opacity: .65; }
  button.primary { width: 100%; padding: 10px; font-size: 14px; font-weight: 700;
    border: none; border-radius: 6px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { width: 100%; padding: 7px; margin-top: 6px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); border-radius: 5px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .chan { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .dot { width: 12px; height: 12px; border-radius: 3px; flex: none; }
  .chan .n { flex: 1; }
  .chan .l { opacity: .6; font-variant-numeric: tabular-nums; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .tag { font-size: 11px; padding: 1px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 10px; }
  .list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; }
  .list button { text-align: left; padding: 5px 7px; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer; width: 100%; }
  .list button:hover { background: var(--vscode-list-hoverBackground); }
  .empty { text-align: center; opacity: .7; padding: 16px 4px; }
</style></head><body>
<div class="wrap" id="root">loading…</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const LOGO = ${JSON.stringify(String(logo))};
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(s){
  if(!s.hasWorkspace){
    root.innerHTML = '<div class="hero"><img src="'+LOGO+'"><b>OpenPlotCNC</b></div>'+
      '<div class="empty">Open the folder that holds your NC programs to get started.</div>'+
      '<button class="primary" data-a="openFolder">Open Folder</button>';
    return;
  }
  let h = '<div class="hero"><img src="'+LOGO+'"><b>OpenPlotCNC</b></div>';
  h += '<div class="card"><h4>Program</h4>';
  if(s.program){
    h += '<div class="prog">'+esc(s.program.name)+'</div>';
    h += '<div class="tags"><span class="tag">'+esc(s.mode==='single-file'?'single file':'multi file')+'</span>'+
         (s.kinematics?'<span class="tag">'+esc(s.kinematics)+'</span>':'')+
         (s.dialect?'<span class="tag">'+esc(s.dialect)+'</span>':'')+'</div>';
  } else {
    h += '<div class="muted">No program selected.</div>';
  }
  h += '<button class="sec" data-a="choose">Choose program…</button></div>';

  if(s.channels.length){
    h += '<div class="card"><h4>Channels ('+s.channels.length+')</h4>';
    for(const c of s.channels){
      h += '<div class="chan"><span class="dot" style="background:'+esc(c.color)+'"></span>'+
           '<span class="n">'+esc(c.name)+'</span><span class="l">'+c.lines+' lines</span></div>';
    }
    if(s.channels.length>1) h += '<div class="muted" style="margin-top:6px">'+s.syncPoints+' sync point'+(s.syncPoints===1?'':'s')+' aligned</div>';
    h += '</div>';
  }

  h += '<button class="primary" data-a="open">Open Backplotter</button>';
  h += '<button class="sec" data-a="setup">Machine &amp; Tooling Setup</button>';

  if(s.found.length && !s.program){
    h += '<div class="card"><h4>Programs in this folder</h4><div class="list">';
    for(const f of s.found) h += '<button data-a="pick" data-uri="'+esc(f.uri)+'">'+esc(f.label)+'</button>';
    h += '</div></div>';
  }
  root.innerHTML = h;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if(!b) return;
  vscode.postMessage({ type: b.dataset.a, uri: b.dataset.uri });
});
window.addEventListener('message', e => { if(e.data && e.data.type==='state') render(e.data.state); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
