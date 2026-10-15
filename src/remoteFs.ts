import * as vscode from 'vscode';
import { posix } from 'path';
import { Profile } from './config';
import type { Services } from './services';
import { friendlyError, isNotFound } from './util';

export const SCHEME = 'sftp-plus';

export function remoteUri(p: Profile, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: p.id, path: remotePath });
}

/**
 * Exposes servers as a VS Code file system (sftp-plus://<profile-id>/abs/path), so remote files
 * open in normal editors, saves write straight to the server, and diffs work against them.
 * VS Code's own "file is newer on disk" check covers edits made by others while a file is open.
 */
export class RemoteFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly s: Services) {}

  private profile(uri: vscode.Uri): Profile {
    const p = this.s.config.byId(uri.authority);
    if (!p) throw vscode.FileSystemError.Unavailable(`No server profile "${uri.authority}" in sftp.json`);
    return p;
  }

  private async op<T>(uri: vscode.Uri, fn: (p: Profile) => Promise<T>): Promise<T> {
    try {
      return await fn(this.profile(uri));
    } catch (err) {
      if (err instanceof vscode.FileSystemError) throw err;
      if (isNotFound(err)) throw vscode.FileSystemError.FileNotFound(uri);
      throw vscode.FileSystemError.Unavailable(friendlyError(err));
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.op(uri, async (p) => {
      const e = await this.s.conns.get(p).run((c) => c.stat(uri.path));
      if (!e) throw vscode.FileSystemError.FileNotFound(uri);
      return {
        type: (e.kind === 'dir' ? vscode.FileType.Directory : vscode.FileType.File) | (e.isLink ? vscode.FileType.SymbolicLink : 0),
        ctime: e.mtime,
        mtime: e.mtime,
        size: e.size,
      };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.op(uri, async (p) => {
      const entries = await this.s.conns.get(p).run((c) => c.list(uri.path));
      return entries.map((e) => [e.name, e.kind === 'dir' ? vscode.FileType.Directory : vscode.FileType.File]);
    });
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.op(uri, (p) => this.s.conns.get(p).run((c) => c.readFile(uri.path)));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    return this.op(uri, async (p) => {
      const created = await this.s.conns.get(p).run(async (c) => {
        const existing = await c.stat(uri.path);
        if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
        if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
        await c.writeFile(uri.path, Buffer.from(content));
        const after = await c.stat(uri.path);
        if (after) this.s.baselines.set(p, uri.path, after);
        return !existing;
      });
      this.emitter.fire([{ type: created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
      if (created) this.s.notifyRemoteChanged(p, posix.dirname(uri.path));
    });
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.op(uri, async (p) => {
      await this.s.conns.get(p).run((c) => c.mkdirp(uri.path));
      this.s.notifyRemoteChanged(p, posix.dirname(uri.path));
    });
  }

  delete(uri: vscode.Uri): Promise<void> {
    return this.op(uri, async (p) => {
      await this.s.conns.get(p).run(async (c) => {
        const e = await c.stat(uri.path);
        if (!e) throw vscode.FileSystemError.FileNotFound(uri);
        await (e.kind === 'dir' && !e.isLink ? c.removeDir(uri.path) : c.removeFile(uri.path));
      });
      this.s.baselines.delete(p, uri.path);
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      this.s.notifyRemoteChanged(p, posix.dirname(uri.path));
    });
  }

  rename(from: vscode.Uri, to: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    return this.op(from, async (p) => {
      await this.s.conns.get(p).run(async (c) => {
        if (!options.overwrite && (await c.stat(to.path))) throw vscode.FileSystemError.FileExists(to);
        await c.rename(from.path, to.path);
      });
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: from },
        { type: vscode.FileChangeType.Created, uri: to },
      ]);
      this.s.notifyRemoteChanged(p);
    });
  }
}
