import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

const options = {
  entryPoints: test ? { 'test/smoke': 'test/smoke.ts' } : { extension: 'src/extension.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  sourcemap: !production,
  minify: production,
  // ssh2 optionally loads a native crypto binding and cpu-features; both fall back to pure JS.
  external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'],
  // jsonc-parser's default UMD build uses dynamic requires esbuild can't follow; its ESM build bundles cleanly.
  mainFields: ['module', 'main'],
  logLevel: 'info',
  ...(test ? { alias: { vscode: './test/vscode-stub.ts' }, external: ['cpu-features', './crypto/build/Release/sshcrypto.node', 'ftp-srv'] } : {}),
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
