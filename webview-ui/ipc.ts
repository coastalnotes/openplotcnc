import type { HostToWebview, WebviewToHost } from '../src/types';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    __OPC__: { workerUri: string };
  }
}

export const vscode: VsCodeApi = acquireVsCodeApi();

export function send(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, message });
}

type Handler = (msg: HostToWebview) => void;

const handlers = new Set<Handler>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HostToWebview & { type?: string };
  if (!msg || typeof msg.type !== 'string') return;
  for (const h of handlers) {
    try {
      h(msg as HostToWebview);
    } catch (err) {
      log('error', `handler failed: ${(err as Error).message}`);
    }
  }
});

export function onHostMessage(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
