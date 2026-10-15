import * as esbuild from 'esbuild';
const common = { bundle: true, format: 'cjs', platform: 'node', target: 'node18', outdir: 'dist/test/integration', logLevel: 'warning', mainFields: ['module', 'main'] };
await esbuild.build({ ...common, entryPoints: ['test/integration/run.ts'], external: ['ftp-srv', '@vscode/test-electron'] });
await esbuild.build({ ...common, entryPoints: ['test/integration/suite.ts'], external: ['vscode'] });
