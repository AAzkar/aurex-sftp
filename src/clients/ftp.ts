import { Client, FileInfo } from 'basic-ftp';
import { posix } from 'path';
import { Readable, Writable } from 'stream';
import { isNotFound } from '../util';
import { RemoteClient, RemoteEntry } from './types';

export interface FtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** true = explicit FTPS (AUTH TLS), 'implicit' = implicit FTPS, false = plain FTP. */
  secure: boolean | 'implicit';
  rejectUnauthorized: boolean;
  timeout: number;
}

/** FTP / FTPS transport. basic-ftp runs one command at a time, so callers must serialise access. */
export class FtpRemote implements RemoteClient {
  private client?: Client;
  home = '/';

  constructor(private readonly opts: FtpOptions) {}

  async connect(): Promise<void> {
    const o = this.opts;
    const client = new Client(o.timeout);
    try {
      await client.access({
        host: o.host,
        port: o.port,
        user: o.user,
        password: o.password,
        secure: o.secure,
        secureOptions: { rejectUnauthorized: o.rejectUnauthorized },
      });
      this.home = await client.pwd();
    } catch (err) {
      client.close();
      throw err;
    }
    this.client = client;
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }

  isAlive(): boolean {
    return !!this.client && !this.client.closed;
  }

  private get c(): Client {
    if (!this.client || this.client.closed) throw new Error('Not connected');
    return this.client;
  }

  private entry(dir: string, info: FileInfo): RemoteEntry {
    const p = info.permissions;
    return {
      name: info.name,
      path: posix.join(dir, info.name),
      kind: info.isDirectory ? 'dir' : info.isSymbolicLink ? 'link' : 'file',
      size: info.size,
      mtime: info.modifiedAt?.getTime() ?? 0,
      mode: p ? (p.user << 6) | (p.group << 3) | p.world : undefined,
    };
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const infos = await this.c.list(dir);
    const entries = infos.filter((i) => i.name !== '.' && i.name !== '..').map((i) => this.entry(dir, i));
    // FTP listings don't say what a symlink points at (e.g. cPanel's www -> public_html); probe with CWD.
    for (const e of entries) {
      if (e.kind !== 'link') continue;
      e.isLink = true;
      try {
        await this.c.cd(e.path);
        e.kind = 'dir';
      } catch {
        e.kind = 'file';
      }
    }
    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const p = posix.normalize(path);
    if (p === '/') return { name: '/', path: '/', kind: 'dir', size: 0, mtime: 0 };
    let entries: RemoteEntry[];
    try {
      entries = await this.list(posix.dirname(p));
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const entry = entries.find((e) => e.name === posix.basename(p));
    // Servers without MLSD give LIST dates basic-ftp can't turn into a timestamp; ask with MDTM instead.
    if (entry?.kind === 'file' && !entry.mtime) {
      entry.mtime = await this.c.lastMod(p).then((d) => d.getTime(), () => 0);
    }
    return entry;
  }

  async readFile(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        chunks.push(chunk);
        done();
      },
    });
    await this.c.downloadTo(sink, path);
    return Buffer.concat(chunks);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.c.uploadFrom(Readable.from([data]), path);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.c.uploadFrom(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.c.downloadTo(localPath, remotePath);
  }

  async mkdirp(dir: string): Promise<void> {
    await this.c.ensureDir(dir);
  }

  async removeFile(path: string): Promise<void> {
    await this.c.remove(path);
  }

  async removeDir(path: string): Promise<void> {
    await this.c.removeDir(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.c.rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.c.send(`SITE CHMOD ${(mode & 0o7777).toString(8)} ${path}`);
  }
}
