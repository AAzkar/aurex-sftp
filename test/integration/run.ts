// Starts a local FTP server and a throwaway workspace, then runs suite.ts in VS Code.
import { runTests } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FtpSrv } = require('ftp-srv');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurex-sftp-it-'));
  const ftpRoot = path.join(tmp, 'server');
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ftpRoot, 'www'), { recursive: true });
  for (const [rel, content] of Object.entries({
    'src/hello.php': '<?php echo 1;',
    'src/other.php': '<?php echo 2;',
    'assets/css/site.css': 'body{}',
    'node_modules/x.js': '',
  })) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  fs.mkdirSync(path.join(ws, '.vscode'));
  fs.writeFileSync(
    path.join(ws, '.vscode', 'sftp.json'),
    `{\n  // deploy target\n  "name": "test",\n  "protocol": "ftp",\n  "host": "127.0.0.1",\n  "port": ${port},\n  "username": "deploy",\n  "password": "s3cret",\n  "remotePath": "/www",\n  "uploadOnSave": true,\n  "ignore": [".vscode", "node_modules"]\n}\n`,
  );

  const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 41000, pasv_max: 41100, log: quiet });
  server.on('login', ({ password }: { password: string }, resolve: (o: object) => void, reject: (e: Error) => void) =>
    password === 's3cret' ? resolve({ root: ftpRoot }) : reject(new Error('bad login')),
  );
  await server.listen();

  let code = 0;
  try {
    await runTests({
      vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.js'),
      extensionTestsEnv: { FTP_ROOT: ftpRoot, AUREX_SFTP_DEBUG: '1' },
      launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(tmp, 'user')}`],
    });
  } catch (err) {
    console.error(err);
    code = 1;
  }
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
main();
