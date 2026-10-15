// Exercises the real transports against local SFTP and FTP servers, plus Connection's reconnect logic.
import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FtpRemote } from '../src/clients/ftp';
import { SftpRemote } from '../src/clients/sftp';
import { HostKeyError, RemoteClient } from '../src/clients/types';
import { Connection } from '../src/connection';
import type { Profile } from '../src/config';
import type { Credentials } from '../src/credentials';
import { friendlyError, isAuthError } from '../src/util';
import { startSftpServer } from './sftp-server';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FtpSrv } = require('ftp-srv');

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

async function exerciseClient(label: string, c: RemoteClient, scratch: string, opts: { chmod: boolean }) {
  const big = crypto.randomBytes(3 * 1024 * 1024 + 123);
  const bigLocal = path.join(scratch, `${label}-big.bin`);
  fs.writeFileSync(bigLocal, big);

  await step(`${label}: mkdirp nested`, async () => {
    await c.mkdirp('/site/a/b/c');
    assert.equal((await c.stat('/site/a/b/c'))?.kind, 'dir');
    await c.mkdirp('/site/a/b/c'); // idempotent
  });
  await step(`${label}: writeFile/readFile round-trip`, async () => {
    await c.writeFile('/site/index.php', Buffer.from('<?php echo "hi";'));
    assert.equal((await c.readFile('/site/index.php')).toString(), '<?php echo "hi";');
    const st = await c.stat('/site/index.php');
    assert.equal(st?.kind, 'file');
    assert.equal(st?.size, 16);
    assert.ok(st!.mtime > 0, 'has mtime');
  });
  await step(`${label}: stat of missing path is undefined`, async () => {
    assert.equal(await c.stat('/site/nope.txt'), undefined);
  });
  await step(`${label}: 3 MB upload/download keeps bytes intact`, async () => {
    await c.uploadFile(bigLocal, '/site/a/big.bin');
    assert.equal((await c.stat('/site/a/big.bin'))?.size, big.length);
    const back = path.join(scratch, `${label}-back.bin`);
    await c.downloadFile('/site/a/big.bin', back);
    assert.equal(sha(fs.readFileSync(back)), sha(big));
  });
  await step(`${label}: list sorts out files and dirs`, async () => {
    const names = (await c.list('/site')).map((e) => `${e.name}:${e.kind}`).sort();
    assert.deepEqual(names, ['a:dir', 'index.php:file']);
  });
  await step(`${label}: rename (also over an existing file)`, async () => {
    await c.rename('/site/index.php', '/site/home.php');
    assert.equal(await c.stat('/site/index.php'), undefined);
    await c.writeFile('/site/other.php', Buffer.from('x'));
    await c.rename('/site/other.php', '/site/home.php').catch(async () => {
      // Same fallback the transfer layer uses when the server refuses to overwrite.
      await c.removeFile('/site/home.php');
      await c.rename('/site/other.php', '/site/home.php');
    });
    assert.equal((await c.readFile('/site/home.php')).toString(), 'x');
  });
  if (opts.chmod) {
    await step(`${label}: chmod`, async () => {
      await c.chmod('/site/home.php', 0o600);
      assert.equal((await c.stat('/site/home.php'))?.mode, 0o600);
    });
  }
  await step(`${label}: removeDir is recursive`, async () => {
    await c.removeDir('/site/a');
    assert.equal(await c.stat('/site/a'), undefined);
    await c.removeFile('/site/home.php');
  });
  // Last: some servers leave the connection unusable after a failed STOR (Connection reconnects in real use).
  await step(`${label}: uploading into a missing dir is an error, not a hang`, async () => {
    await assert.rejects(c.uploadFile(bigLocal, '/site/missing/dir/x.bin'));
  });
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-plus-test-'));
  const sftpRoot = path.join(scratch, 'sftp-root');
  const ftpRoot = path.join(scratch, 'ftp-root');
  fs.mkdirSync(sftpRoot);
  fs.mkdirSync(ftpRoot);

  console.log('SFTP');
  const sftpServer = await startSftpServer(sftpRoot, 'deploy', 's3cret');
  const base = { host: '127.0.0.1', port: sftpServer.port, username: 'deploy', readyTimeout: 5000 };
  let trusted = '';
  await step('sftp: unknown host key is rejected with its fingerprint', async () => {
    const c = new SftpRemote({ ...base, password: 's3cret' });
    const err = await c.connect().then(() => undefined, (e) => e);
    assert.ok(err instanceof HostKeyError, `expected HostKeyError, got ${err}`);
    assert.match(err.fingerprint, /^SHA256:/);
    assert.equal(err.expected, undefined);
    trusted = err.fingerprint;
  });
  await step('sftp: changed host key is reported as changed', async () => {
    const err = await new SftpRemote({ ...base, password: 's3cret', trustedFingerprint: 'SHA256:old' }).connect().then(() => undefined, (e) => e);
    assert.ok(err instanceof HostKeyError && err.expected === 'SHA256:old');
  });
  await step('sftp: wrong password is an auth error', async () => {
    const err = await new SftpRemote({ ...base, password: 'nope', trustedFingerprint: trusted }).connect().then(() => undefined, (e) => e);
    assert.ok(isAuthError(err), `expected auth error, got ${err}`);
    assert.match(friendlyError(err), /Login failed/);
  });
  const sftp = new SftpRemote({ ...base, password: 's3cret', trustedFingerprint: trusted });
  await step('sftp: connects with the trusted key', async () => {
    await sftp.connect();
    assert.ok(sftp.isAlive());
    assert.equal(sftp.home, '/');
  });
  await exerciseClient('sftp', sftp, scratch, { chmod: true });
  await sftp.close();

  await step('connection: reconnects and retries after the server drops it', async () => {
    const profile = {
      id: 't', name: 'test', protocol: 'sftp', host: '127.0.0.1', port: sftpServer.port, username: 'deploy',
      password: 's3cret', remotePath: 'site', concurrency: 4, connectTimeout: 5000,
    } as unknown as Profile;
    const creds = { trustedHostKey: () => trusted, password: async () => 's3cret' } as unknown as Credentials;
    const states: string[] = [];
    const conn = new Connection(profile, creds, (c) => states.push(c.state));
    fs.mkdirSync(path.join(sftpRoot, 'site'), { recursive: true });
    fs.writeFileSync(path.join(sftpRoot, 'site', 'f.txt'), 'hello');
    assert.equal(await conn.root(), '/site', 'relative remotePath resolves against the login dir');
    sftpServer.dropAll();
    await new Promise((r) => setTimeout(r, 200));
    const text = await conn.run(async (c, root) => (await c.readFile(`${root}/f.txt`)).toString());
    assert.equal(text, 'hello');
    assert.deepEqual(states, ['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
    // Parallel operations share one connection attempt.
    const results = await Promise.all(Array.from({ length: 10 }, () => conn.run((c, root) => c.stat(`${root}/f.txt`))));
    assert.ok(results.every((r) => r?.size === 5));
    conn.dispose();
  });
  await sftpServer.close();

  console.log('FTP');
  const ftpPort = 20000 + Math.floor(Math.random() * 20000);
  const ftpServer = new FtpSrv({ url: `ftp://127.0.0.1:${ftpPort}`, pasv_url: '127.0.0.1', pasv_min: 40000, pasv_max: 40100, anonymous: false, log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  ftpServer.on('login', ({ username, password }: { username: string; password: string }, resolve: (o: object) => void, reject: (e: Error) => void) =>
    username === 'deploy' && password === 's3cret' ? resolve({ root: ftpRoot }) : reject(new Error('Bad login')),
  );
  await ftpServer.listen();
  const ftpOpts = { host: '127.0.0.1', port: ftpPort, user: 'deploy', secure: false as const, rejectUnauthorized: true, timeout: 5000 };
  await step('ftp: wrong password is an auth error', async () => {
    const err = await new FtpRemote({ ...ftpOpts, password: 'nope' }).connect().then(() => undefined, (e) => e);
    assert.ok(isAuthError(err), `expected auth error, got ${err} (code ${err?.code})`);
  });
  const ftp = new FtpRemote({ ...ftpOpts, password: 's3cret' });
  await step('ftp: connects', async () => {
    await ftp.connect();
    assert.ok(ftp.isAlive());
  });
  await exerciseClient('ftp', ftp, scratch, { chmod: false });
  await ftp.close();
  assert.ok(!ftp.isAlive());
  await ftpServer.close();

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
