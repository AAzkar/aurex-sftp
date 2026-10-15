import { Client, SFTPWrapper, utils } from 'ssh2';
import type { Attributes } from 'ssh2';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { posix } from 'path';
import { HostKeyError, RemoteClient, RemoteEntry } from './types';

export interface SftpOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  agent?: string;
  readyTimeout: number;
  /** OpenSSH-style "SHA256:…" fingerprint the user trusted earlier, if any. */
  trustedFingerprint?: string;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

type Done<T> = (err: Error | null | undefined, value?: T) => void;
const call = <T = void>(fn: (done: Done<T>) => void) =>
  new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))));

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** True when the private key is encrypted and no passphrase was supplied. */
export function keyNeedsPassphrase(key: Buffer): boolean {
  const parsed = utils.parseKey(key);
  return parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message);
}

export class SftpRemote implements RemoteClient {
  private ssh?: Client;
  private sftp?: SFTPWrapper;
  private alive = false;
  home = '/';

  constructor(private readonly opts: SftpOptions) {}

  async connect(): Promise<void> {
    const o = this.opts;
    const ssh = new Client();
    let offeredKey: string | undefined;
    await new Promise<void>((resolve, reject) => {
      ssh.once('ready', () => resolve());
      ssh.once('error', (err) => reject(offeredKey ? new HostKeyError(offeredKey, o.trustedFingerprint) : err));
      // Some servers only offer keyboard-interactive; answer every prompt with the password.
      ssh.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) =>
        finish(prompts.map(() => o.password ?? '')),
      );
      ssh.connect({
        host: o.host,
        port: o.port,
        username: o.username,
        password: o.password,
        privateKey: o.privateKey,
        passphrase: o.passphrase,
        agent: o.agent,
        tryKeyboard: o.password !== undefined,
        readyTimeout: o.readyTimeout,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        // Reject unknown keys here; the Connection asks the user and reconnects if they trust it.
        hostVerifier: (key: Buffer) => {
          const fp = fingerprint(key);
          if (fp === o.trustedFingerprint) return true;
          offeredKey = fp;
          return false;
        },
      });
    });
    ssh.on('error', () => (this.alive = false));
    ssh.on('close', () => (this.alive = false));
    ssh.on('end', () => (this.alive = false));
    this.ssh = ssh;
    this.sftp = await call<SFTPWrapper>((done) => ssh.sftp(done));
    this.alive = true;
    this.home = await call<string>((done) => this.s.realpath('.', done));
  }

  async close(): Promise<void> {
    this.alive = false;
    this.ssh?.end();
    this.ssh = undefined;
    this.sftp = undefined;
  }

  isAlive(): boolean {
    return this.alive;
  }

  private get s(): SFTPWrapper {
    if (!this.sftp || !this.alive) throw new Error('Not connected');
    return this.sftp;
  }

  private entry(path: string, a: Attributes): RemoteEntry {
    const type = a.mode & S_IFMT;
    return {
      name: posix.basename(path) || '/',
      path,
      kind: type === S_IFDIR ? 'dir' : type === S_IFLNK ? 'link' : 'file',
      size: a.size,
      mtime: a.mtime * 1000,
      mode: a.mode & 0o7777,
    };
  }

  /** Lists a directory. Symlinks are resolved to their target's kind unless `resolveLinks` is false. */
  async list(dir: string, resolveLinks = true): Promise<RemoteEntry[]> {
    const items = await call<{ filename: string; attrs: Attributes }[]>((done) => this.s.readdir(dir, done));
    const entries = items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => this.entry(posix.join(dir, i.filename), i.attrs));
    if (!resolveLinks) return entries;
    return Promise.all(
      entries.map(async (e) => {
        if (e.kind !== 'link') return e;
        const target = await this.stat(e.path).catch(() => undefined);
        return { ...e, kind: target?.kind === 'dir' ? 'dir' : 'file', isLink: true } as RemoteEntry;
      }),
    );
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    try {
      return this.entry(path, await call<Attributes>((done) => this.s.stat(path, done)));
    } catch (err) {
      if ((err as { code?: number }).code === 2) return undefined;
      throw err;
    }
  }

  readFile(path: string): Promise<Buffer> {
    return call<Buffer>((done) => this.s.readFile(path, done));
  }

  writeFile(path: string, data: Buffer): Promise<void> {
    return call((done) => this.s.writeFile(path, data, done));
  }

  uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.s;
    return new Promise((resolve, reject) => {
      const source = fs.createReadStream(localPath);
      const target = sftp.createWriteStream(remotePath);
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        source.destroy();
        target.destroy();
        reject(err);
      };
      source.on('error', fail);
      target.on('error', fail);
      // 'close' fires once the remote handle is closed, i.e. the data is committed on the server.
      target.on('close', () => !failed && resolve());
      source.pipe(target);
    });
  }

  downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = this.s;
    return new Promise((resolve, reject) => {
      const source = sftp.createReadStream(remotePath);
      const target = fs.createWriteStream(localPath);
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        source.destroy();
        target.destroy();
        reject(err);
      };
      source.on('error', fail);
      target.on('error', fail);
      target.on('close', () => !failed && resolve());
      source.pipe(target);
    });
  }

  async mkdirp(dir: string): Promise<void> {
    if ((await this.stat(dir))?.kind === 'dir') return;
    let current = dir.startsWith('/') ? '' : '.';
    for (const part of dir.split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      const st = await this.stat(current);
      if (st?.kind === 'dir') continue;
      if (st) throw new Error(`${current} exists and is not a directory`);
      try {
        await call((done) => this.s.mkdir(current, done));
      } catch (err) {
        // Someone else may have created it in the meantime.
        if ((await this.stat(current))?.kind !== 'dir') throw err;
      }
    }
  }

  removeFile(path: string): Promise<void> {
    return call((done) => this.s.unlink(path, done));
  }

  async removeDir(path: string): Promise<void> {
    for (const e of await this.list(path, false)) {
      if (e.kind === 'dir') await this.removeDir(e.path);
      else await this.removeFile(e.path);
    }
    await call((done) => this.s.rmdir(path, done));
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      // posix-rename replaces an existing target atomically, which plain SFTP rename cannot.
      await call((done) => this.s.ext_openssh_rename(from, to, done));
    } catch {
      await call((done) => this.s.rename(from, to, done));
    }
  }

  chmod(path: string, mode: number): Promise<void> {
    return call((done) => this.s.chmod(path, mode, done));
  }
}
