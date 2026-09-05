/**
 * Must be imported before any `monaco-editor` module so the editor can spin up
 * its language worker. VS Code webviews run on a different origin than the
 * bundled worker asset, so we blob-wrap it and `importScripts` the real file.
 */
declare const self: {
  MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
};

self.MonacoEnvironment = {
  getWorker() {
    const url = window.__OPC__?.workerUri;
    if (!url) {
      // No worker available — Monaco degrades gracefully to main-thread only.
      const noop = new Blob([''], { type: 'application/javascript' });
      return new Worker(URL.createObjectURL(noop));
    }
    const shim = `importScripts(${JSON.stringify(url)});`;
    const blob = new Blob([shim], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  },
};

export {};
