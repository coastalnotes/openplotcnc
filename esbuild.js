'use strict';

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✖ ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      }
      const label = build.initialOptions.outfile || build.initialOptions.outdir;
      console.log(`[esbuild] ${label} — ${result.errors.length} error(s)`);
    });
  },
};

const base = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  plugins: [problemMatcherPlugin],
};

/** Extension host — Node / CommonJS. */
const extensionConfig = {
  ...base,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

/** Webview main bundle — browser ESM, contains Monaco + Three.js. */
const webviewConfig = {
  ...base,
  entryPoints: { main: 'webview-ui/main.ts' },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  loader: { '.ttf': 'dataurl', '.css': 'css' },
};

/** Monaco editor worker — classic IIFE so it can be blob-wrapped in the webview. */
const workerConfig = {
  ...base,
  entryPoints: {
    'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

async function run() {
  const configs = [extensionConfig, webviewConfig, workerConfig];
  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[esbuild] watching…');
  } else {
    const results = await Promise.all(configs.map((c) => esbuild.build(c)));
    if (results.some((r) => r.errors.length)) process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { extensionConfig, webviewConfig, workerConfig };
