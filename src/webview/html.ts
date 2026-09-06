import * as vscode from 'vscode';

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const n = nonce();
  const asset = (...p: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...p));

  const mainJs = asset('main.js');
  const mainCss = asset('main.css');
  const workerJs = asset('editor.worker.js');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}' ${webview.cspSource} blob:`,
    `worker-src blob:`,
    `connect-src ${webview.cspSource} blob: data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${mainCss}" />
  <title>OpenPlotCNC Backplotter</title>
</head>
<body>
  <div id="app" data-layout="split">
    <div id="ribbon"></div>
    <div id="split">
      <section id="editors-pane">
        <header class="pane-header">
          <span class="pane-title">Channels</span>
          <span class="pane-info" id="channels-info"></span>
          <span class="pane-actions">
            <button id="btn-review" class="pane-btn" title="Review: syntax errors + sync-code check">Review</button>
            <button id="btn-expand-editor" class="pane-btn" title="Toggle the 3D pane">Widen ⤢</button>
          </span>
        </header>
        <div id="review-panel" hidden></div>
        <div id="editors"></div>
      </section>
      <div id="gutter" title="Drag to resize"></div>
      <section id="viewport-pane">
        <header class="pane-header">
          <span class="pane-title">3D Backplot</span>
          <span class="pane-info" id="viewport-info"></span>
        </header>
        <div id="viewport">
          <canvas id="scene"></canvas>
          <div id="viewport-idle">
            <div class="idle-card">
              <div class="idle-glyph">▤</div>
              <p>Channels are split and aligned on the left.</p>
              <button id="idle-run" class="big-primary">Run Backplot</button>
              <p class="idle-hint">Nothing is simulated until you run it.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
    <div id="transport"></div>
    <div id="config-modal" hidden></div>
    <div id="help-modal" hidden></div>
    <div id="toast" hidden></div>
  </div>
  <script nonce="${n}">
    window.__OPC__ = { workerUri: ${JSON.stringify(String(workerJs))} };
  </script>
  <script type="module" nonce="${n}" src="${mainJs}"></script>
</body>
</html>`;
}
