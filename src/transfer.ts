import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { RemoteClient, RemoteEntry } from './clients/types';
import { isIgnored, localFor, Profile, relativeLocal, remoteJoin } from './config';
import { log } from './log';
import { remoteUri } from './remoteFs';
import { Baselines, describeEntry, Services } from './services';
import { isConnectionError, mapLimit } from './util';

export interface LocalFile {
  rel: string;
  fsPath: string;
  size: number;
  mtime: number;
}

/**
 * Uploads `local` to `remote`, creating missing parent directories; optionally via a temp file + rename.
 * `newFile` (no baseline yet) makes sure the parent exists first: a failed STOR leaves some FTP servers'
 * connections in a bad state, so it's better not to provoke one.
 */
async function put(c: RemoteClient, local: string, remote: string, useTempFile: boolean, newFile: boolean): Promise<void> {
  const target = useTempFile ? posix.join(posix.dirname(remote), `.${posix.basename(remote)}.sftp-plus.tmp`) : remote;
  if (newFile) await c.mkdirp(posix.dirname(remote));
  try {
    await c.uploadFile(local, target);
  } catch (err) {
    if (isConnectionError(err) || !c.isAlive()) throw err;
    // Most often the parent directory doesn't exist yet. If that wasn't it, this retry fails with the real error.
    await c.mkdirp(posix.dirname(remote));
    await c.uploadFile(local, target);
  }
  if (useTempFile) {
    try {
      await c.rename(target, remote);
    } catch {
      await c.removeFile(remote).catch(() => undefined);
      await c.rename(target, remote);
    }
  }
}

/** Downloads to a temp file first so a failed transfer never leaves a truncated local file behind. */
async function get(c: RemoteClient, remote: string, local: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  const temp = `${local}.sftp-plus-download`;
  try {
    await c.downloadFile(remote, temp);
    await fs.promises.rename(temp, local);
  } catch (err) {
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
}

export function isDirty(fsPath: string): boolean {
  return vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
}

export type UploadResult = 'uploaded' | 'skipped' | 'downloaded';

/**
 * Uploads one local file. With `checkConflict`, first compares the server copy against the
 * baseline from our last sync and asks before overwriting changes made by someone else.
 */
export async function uploadFile(s: Services, p: Profile, local: string, opts: { checkConflict?: boolean } = {}): Promise<UploadResult> {
  const rel = relativeLocal(p, local);
  if (rel === undefined) throw new Error(`${local} is outside ${p.localRoot}`);
  const conn = s.conns.get(p);
  const localStat = await fs.promises.stat(local);

  if (opts.checkConflict && vscode.workspace.getConfiguration('sftpPlus').get<boolean>('conflictDetection', true)) {
    const [remotePath, remote] = await conn.run(async (c, root) => {
      const rp = remoteJoin(root, rel);
      return [rp, await c.stat(rp)] as const;
    });
    const base = s.baselines.get(p, remotePath);
    if (remote && base && Baselines.remoteChanged(remote, base)) {
      log.warn(`${rel} changed on ${p.name} since last sync (server ${remote.size} B @ ${remote.mtime}, last synced ${base.size} B @ ${base.mtime})`);
      const decision = await resolveConflict(s, p, local, remotePath, remote, base);
      if (decision === 'skip') return 'skipped';
      if (decision === 'download') {
        await downloadFile(s, p, remotePath, local);
        return 'downloaded';
      }
    }
  }

  const remotePath = await conn.run(async (c, root) => {
    const rp = remoteJoin(root, rel);
    await put(c, local, rp, p.useTempFile, !s.baselines.get(p, rp));
    const after = await c.stat(rp);
    if (after) s.baselines.set(p, rp, after, localStat.mtimeMs);
    return rp;
  });
  log.info(`Uploaded ${rel} → ${p.name}:${remotePath}`);
  s.notifyRemoteChanged(p, posix.dirname(remotePath));
  return 'uploaded';
}

async function resolveConflict(
  s: Services,
  p: Profile,
  local: string,
  remotePath: string,
  remote: RemoteEntry,
  base: { size: number; mtime: number },
): Promise<'overwrite' | 'skip' | 'download'> {
  const name = path.basename(local);
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      `${name} was changed on ${p.name} since you last synced it.`,
      {
        modal: true,
        detail: `Someone (or another tool) modified the server copy.\n\nOn server now: ${describeEntry(remote)}\nWhen you last synced: ${describeEntry(base)}\n\nUploading will replace their changes.`,
      },
      'Compare',
      'Overwrite Server',
      'Use Server Version',
    );
    if (choice === 'Overwrite Server') return 'overwrite';
    if (choice === 'Use Server Version') {
      if (isDirty(local)) {
        void vscode.window.showWarningMessage(`${name} has unsaved changes; save or revert it first.`);
        return 'skip';
      }
      return 'download';
    }
    if (choice !== 'Compare') return 'skip';
    await vscode.commands.executeCommand('vscode.diff', remoteUri(p, remotePath), vscode.Uri.file(local), `${name} (Server ↔ Local)`);
  }
}

export async function downloadFile(s: Services, p: Profile, remotePath: string, local: string): Promise<void> {
  await s.conns.get(p).run(async (c) => {
    await get(c, remotePath, local);
    const [remote, localStat] = await Promise.all([c.stat(remotePath), fs.promises.stat(local)]);
    if (remote) s.baselines.set(p, remotePath, remote, localStat.mtimeMs);
  });
  log.info(`Downloaded ${p.name}:${remotePath} → ${local}`);
}

export async function deleteRemote(s: Services, p: Profile, entry: Pick<RemoteEntry, 'path' | 'kind'>): Promise<void> {
  await s.conns.get(p).run((c) => (entry.kind === 'dir' ? c.removeDir(entry.path) : c.removeFile(entry.path)));
  s.baselines.delete(p, entry.path);
  log.info(`Deleted ${p.name}:${entry.path}`);
}

/** All non-ignored files under `dir` (which must be inside the profile's local root). */
export async function walkLocal(p: Profile, dir: string): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const visit = async (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fsPath = path.join(d, e.name);
      const rel = relativeLocal(p, fsPath)!;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        const st = await fs.promises.stat(fsPath).catch(() => undefined);
        // Follow links to files only; following directory links risks cycles.
        isFile = !!st?.isFile();
        isDir = false;
      }
      if (isIgnored(p, rel, isDir)) continue;
      if (isDir) await visit(fsPath);
      else if (isFile) {
        const st = await fs.promises.stat(fsPath);
        out.push({ rel, fsPath, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await visit(dir);
  return out;
}

/**
 * All non-ignored files under remote `dir`, keyed by path relative to the profile's remote root.
 * Lists one directory level at a time, in parallel where the protocol allows.
 */
export async function walkRemote(
  s: Services,
  p: Profile,
  dir: string,
  isCancelled: () => boolean,
): Promise<{ root: string; files: Map<string, RemoteEntry> }> {
  const conn = s.conns.get(p);
  const root = await conn.root();
  const files = new Map<string, RemoteEntry>();
  let level = [dir];
  while (level.length && !isCancelled()) {
    const listings = await Promise.all(
      level.map((d) =>
        conn.run((c) => c.list(d)).catch((err) => {
          log.warn(`Could not list ${p.name}:${d}: ${err}`);
          return [] as RemoteEntry[];
        }),
      ),
    );
    level = [];
    for (const entry of listings.flat()) {
      const rel = posix.relative(root, entry.path);
      if (rel.startsWith('..') || isIgnored(p, rel, entry.kind === 'dir')) continue;
      if (entry.kind === 'dir') {
        // Don't descend into symlinked directories; they can loop.
        if (!entry.isLink) level.push(entry.path);
      } else files.set(rel, entry);
    }
  }
  return { root, files };
}

/** Uploads a local file or folder (recursively, honouring ignore rules) with progress. */
export async function uploadPaths(s: Services, p: Profile, locals: string[]): Promise<void> {
  const files: LocalFile[] = [];
  for (const local of locals) {
    const st = await fs.promises.stat(local);
    if (st.isDirectory()) files.push(...(await walkLocal(p, local)));
    else files.push({ rel: relativeLocal(p, local)!, fsPath: local, size: st.size, mtime: st.mtimeMs });
  }
  if (files.length === 1) {
    await uploadFile(s, p, files[0].fsPath, { checkConflict: true });
    return;
  }
  await runBatch(s, p, `Uploading to ${p.name}`, files, (f) => f.rel, (f) => uploadFile(s, p, f.fsPath));
}

/** Downloads remote paths (files or folders) into the local mapping with progress. */
export async function downloadPaths(s: Services, p: Profile, remotePaths: string[], targetFor?: (remotePath: string, root: string) => string | undefined): Promise<void> {
  const conn = s.conns.get(p);
  const root = await conn.root();
  const jobs: { remotePath: string; local: string }[] = [];
  for (const rp of remotePaths) {
    const st = await conn.run((c) => c.stat(rp));
    if (!st) throw vscode.FileSystemError.FileNotFound(rp);
    const files = st.kind === 'dir' ? [...(await walkRemote(s, p, rp, () => false)).files.values()] : [st];
    for (const f of files) {
      const local = (targetFor ?? ((r, rt) => localFor(p, rt, r)))(f.path, root);
      if (!local) throw new Error(`${f.path} is outside the mapped folder ${root}`);
      if (isDirty(local)) {
        void vscode.window.showWarningMessage(`Skipped ${path.basename(local)}: it has unsaved changes.`);
        continue;
      }
      jobs.push({ remotePath: f.path, local });
    }
  }
  await runBatch(s, p, `Downloading from ${p.name}`, jobs, (j) => posix.relative(root, j.remotePath), (j) => downloadFile(s, p, j.remotePath, j.local));
}

/** Runs transfers with a cancellable progress notification and a summary of failures. */
export async function runBatch<T>(s: Services, p: Profile, title: string, items: T[], label: (t: T) => string, fn: (t: T) => Promise<unknown>): Promise<void> {
  if (!items.length) return;
  const failures: string[] = [];
  let done = 0;
  const status = s.status.begin(`${title} (${items.length})`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      await mapLimit(
        items,
        p.protocol === 'sftp' ? p.concurrency : 1,
        async (item) => {
          try {
            await fn(item);
          } catch (err) {
            failures.push(`${label(item)}: ${err instanceof Error ? err.message : err}`);
            log.error(`${title}: ${label(item)}: ${err}`);
          }
          done++;
          progress.report({ increment: 100 / items.length, message: `${done}/${items.length} ${label(item)}` });
        },
        () => token.isCancellationRequested,
      );
    },
  );
  s.notifyRemoteChanged(p);
  if (failures.length) {
    status.fail(`${failures.length} transfer(s) failed`);
    const choice = await vscode.window.showErrorMessage(`${title}: ${failures.length} of ${items.length} failed. ${failures.slice(0, 3).join('; ')}`, 'Show Log');
    if (choice) log.show();
  } else {
    status.ok(`${done} file(s) done`);
  }
}
