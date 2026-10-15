import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { RemoteEntry } from './clients/types';
import { isIgnored, localFor, Profile, relativeLocal, remoteJoin } from './config';
import { log } from './log';
import { remoteUri } from './remoteFs';
import { Baselines, Services } from './services';
import { deleteRemote, downloadFile, isDirty, LocalFile, runBatch, uploadFile, walkLocal, walkRemote } from './transfer';
import { formatBytes } from './util';

/** Debounced, coalescing upload-on-save: rapid saves of one file collapse into one upload, never two in parallel. */
export class AutoUploader implements vscode.Disposable {
  private readonly pending = new Map<string, { timer?: NodeJS.Timeout; running: boolean; again: boolean }>();
  private readonly disposable: vscode.Disposable;

  constructor(private readonly s: Services) {
    this.disposable = vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc));
  }

  private onSave(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    for (const p of this.s.config.forPath(doc.uri.fsPath)) {
      if (!p.uploadOnSave) continue;
      const rel = relativeLocal(p, doc.uri.fsPath)!;
      if (isIgnored(p, rel, false)) continue;
      this.schedule(p, doc.uri.fsPath);
    }
  }

  schedule(p: Profile, file: string) {
    const key = `${p.id}|${file}`;
    const state = this.pending.get(key) ?? { running: false, again: false };
    this.pending.set(key, state);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.fire(key, p, file), 300);
  }

  private async fire(key: string, p: Profile, file: string) {
    const state = this.pending.get(key);
    if (!state) return;
    state.timer = undefined;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      await this.upload(p, file);
    } finally {
      state.running = false;
      if (state.again) {
        state.again = false;
        void this.fire(key, p, file);
      } else if (!state.timer) this.pending.delete(key);
    }
  }

  private async upload(p: Profile, file: string) {
    const name = path.basename(file);
    const status = this.s.status.begin(`${name} → ${p.name}`);
    try {
      const result = await uploadFile(this.s, p, file, { checkConflict: true });
      if (result === 'uploaded') {
        status.ok(`${name} uploaded to ${p.name}`);
        if (vscode.workspace.getConfiguration('aurexSftp').get<boolean>('showUploadNotifications')) {
          void vscode.window.showInformationMessage(`Uploaded ${name} to ${p.name}`);
        }
      } else status.ok(result === 'downloaded' ? `${name} replaced with server version` : `${name} not uploaded`);
    } catch (err) {
      status.fail(`${name} upload failed`);
      void this.s.reportError(`Uploading ${name} to ${p.name} failed`, err, () => this.schedule(p, file));
    }
  }

  dispose() {
    this.disposable.dispose();
    for (const s of this.pending.values()) clearTimeout(s.timer);
  }
}

const COMPARE_LIMIT = 2 * 1024 * 1024;

/**
 * When a local file is opened, checks the server copy in the background so you never start editing
 * an outdated file. Identical content records a baseline (which arms conflict detection on save);
 * a difference downloads the server version automatically ("downloadOnOpen", the default) unless the local
 * copy has changes of its own, in which case it offers Download / Compare / Keep Mine.
 */
export class OpenChecker implements vscode.Disposable {
  private readonly recent = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly s: Services) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => void this.check(doc)),
      // Editors restored from the last session were opened before we activated.
      s.config.onDidChange(() => vscode.workspace.textDocuments.forEach((doc) => void this.check(doc))),
    );
  }

  private async check(doc: vscode.TextDocument): Promise<void> {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.getConfiguration('aurexSftp').get<boolean>('checkOnOpen', true)) return;
    const local = doc.uri.fsPath;
    const p = this.s.config.forPath(local)[0];
    if (!p) return;
    const rel = relativeLocal(p, local)!;
    if (!rel || isIgnored(p, rel, false)) return;
    const key = `${p.id}|${local}`;
    if (Date.now() - (this.recent.get(key) ?? 0) < 30_000) return;
    this.recent.set(key, Date.now());

    try {
      const localStat = await fs.promises.stat(local);
      const result = await this.s.conns.get(p).run(async (c, root) => {
        const remotePath = remoteJoin(root, rel);
        const remote = await c.stat(remotePath);
        if (!remote || remote.kind !== 'file') return undefined;
        const base = this.s.baselines.get(p, remotePath);
        if (base) return { remotePath, remote, differs: Baselines.remoteChanged(remote, base), reason: 'was changed on the server since you last synced it' };
        if (remote.size !== localStat.size) return { remotePath, remote, differs: true, reason: 'is different on the server' };
        if (remote.size > COMPARE_LIMIT) return undefined; // same size, too big to compare cheaply
        const [theirs, ours] = await Promise.all([c.readFile(remotePath), fs.promises.readFile(local)]);
        return { remotePath, remote, differs: !theirs.equals(ours), reason: 'is different on the server' };
      });
      if (!result) return;
      const { remotePath, remote } = result;
      if (!result.differs) {
        if (!this.s.baselines.get(p, remotePath)) this.s.baselines.set(p, remotePath, remote, localStat.mtimeMs);
        return;
      }
      log.info(`${rel} ${result.reason} (${p.name})`);
      const name = path.basename(local);
      // Only replace the local copy automatically when it holds nothing the server lacks.
      const base = this.s.baselines.get(p, remotePath);
      const localModified =
        base?.localMtime !== undefined
          ? Math.abs(localStat.mtimeMs - base.localMtime) > 1000
          : !remote.mtime || localStat.mtimeMs > remote.mtime + 1000;
      const auto = p.downloadOnOpen ?? vscode.workspace.getConfiguration('aurexSftp').get<boolean>('downloadOnOpen', true);
      if (auto && localModified) result.reason += ', and your local copy has changes of its own';
      if (auto && !localModified && !doc.isDirty) {
        await downloadFile(this.s, p, remotePath, local);
        this.s.status.note(`${name}: loaded the server version`);
        return;
      }
      for (;;) {
        const choice = await vscode.window.showWarningMessage(`${name} ${result.reason} (${p.name}).`, 'Download', 'Compare', 'Keep Mine');
        if (choice === 'Compare') {
          await vscode.commands.executeCommand('vscode.diff', remoteUri(p, remotePath), doc.uri, `${name} (${p.name} ↔ Local)`);
          continue;
        }
        if (choice === 'Download') {
          if (doc.isDirty) {
            void vscode.window.showWarningMessage(`${name} has unsaved changes; save or revert it first.`);
            return;
          }
          await downloadFile(this.s, p, remotePath, local);
        } else if (choice === 'Keep Mine') {
          // Accept the server state as seen, so the next save uploads without asking again.
          this.s.baselines.set(p, remotePath, remote, localStat.mtimeMs);
        }
        return;
      }
    } catch (err) {
      log.warn(`Could not check ${rel} on ${p.name}: ${err}`);
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

type Action = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal';

interface PlanItem extends vscode.QuickPickItem {
  rel: string;
  action: Action;
  local?: LocalFile;
  remote?: RemoteEntry;
  recommended: boolean;
}

const ICONS: Record<Action, string> = {
  upload: '$(arrow-up)',
  download: '$(arrow-down)',
  deleteRemote: '$(trash)',
  deleteLocal: '$(trash)',
};

/**
 * Compares a local folder with its remote counterpart and returns what would change.
 * Uses per-file baselines from earlier syncs to tell "changed here" from "changed there";
 * without a baseline it falls back to size, then to modification time.
 */
async function plan(s: Services, p: Profile, localDir: string, direction: 'up' | 'down', isCancelled: () => boolean): Promise<PlanItem[]> {
  const conn = s.conns.get(p);
  const root = await conn.root();
  const relDir = relativeLocal(p, localDir) ?? '';
  const [localFiles, remote] = await Promise.all([walkLocal(p, localDir), walkRemote(s, p, remoteJoin(root, relDir), isCancelled)]);
  const locals = new Map(localFiles.map((f) => [f.rel, f]));
  const items: PlanItem[] = [];
  const add = (rel: string, action: Action, detail: string, recommended: boolean, local?: LocalFile, r?: RemoteEntry) =>
    items.push({ rel, action, detail, recommended, local, remote: r, label: `${ICONS[action]} ${rel}`, picked: recommended });

  for (const [rel, local] of locals) {
    const r = remote.files.get(rel);
    if (!r) {
      if (direction === 'up') add(rel, 'upload', `New locally · ${formatBytes(local.size)}`, true, local);
      else add(rel, 'deleteLocal', 'Only exists locally · delete local copy', false, local);
      continue;
    }
    const base = s.baselines.get(p, r.path);
    const remoteChanged = base ? Baselines.remoteChanged(r, base) : undefined;
    const localChanged = base?.localMtime !== undefined ? Math.abs(local.mtime - base.localMtime) > 1000 || local.size !== base.size : undefined;
    if (remoteChanged === false && localChanged === false) continue; // in sync since last time

    if (remoteChanged !== undefined && localChanged !== undefined) {
      if (remoteChanged && localChanged) {
        add(rel, direction === 'up' ? 'upload' : 'download', '⚠ Changed on both sides since last sync, compare first', false, local, r);
      } else if (localChanged) {
        if (direction === 'up') add(rel, 'upload', 'Changed locally', true, local, r);
        else add(rel, 'download', '⚠ Changed locally only; downloading discards your change', false, local, r);
      } else {
        if (direction === 'down') add(rel, 'download', 'Changed on server', true, local, r);
        else add(rel, 'upload', '⚠ Changed on server only; uploading discards that change', false, local, r);
      }
      continue;
    }
    // No baseline: we have never synced this file through Aurex SFTP.
    if (local.size !== r.size) {
      add(rel, direction === 'up' ? 'upload' : 'download', `Different size (local ${formatBytes(local.size)}, server ${formatBytes(r.size)})`, true, local, r);
    } else if (r.mtime && Math.abs(local.mtime - r.mtime) > 2000) {
      const newerHere = local.mtime > r.mtime;
      const wanted = direction === 'up' ? newerHere : !newerHere;
      add(rel, direction === 'up' ? 'upload' : 'download', `Same size, ${newerHere ? 'local' : 'server'} copy is newer`, wanted, local, r);
    }
  }
  for (const [rel, r] of remote.files) {
    if (locals.has(rel)) continue;
    if (direction === 'down') add(rel, 'download', `New on server · ${formatBytes(r.size)}`, true, undefined, r);
    else add(rel, 'deleteRemote', 'Only exists on server · delete from server', false, undefined, r);
  }
  return items.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function syncFolder(s: Services, p: Profile, localDir: string, direction: 'up' | 'down'): Promise<void> {
  const where = vscode.workspace.asRelativePath(localDir, false) || path.basename(localDir);
  const title = direction === 'up' ? `Sync ${where} → ${p.name}` : `Sync ${p.name} → ${where}`;
  let items: PlanItem[] | undefined;
  try {
    items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${title}: comparing…`, cancellable: true },
      (_progress, token) => plan(s, p, localDir, direction, () => token.isCancellationRequested).then((r) => (token.isCancellationRequested ? undefined : r)),
    );
  } catch (err) {
    await s.reportError(`${title} failed`, err);
    return;
  }
  if (!items) return;
  if (!items.length) {
    void vscode.window.showInformationMessage(`${title}: everything is already in sync.`);
    return;
  }
  const chosen = await pickPlan(s, p, title, items);
  if (!chosen?.length) return;

  const deletions = chosen.filter((i) => i.action === 'deleteRemote' || i.action === 'deleteLocal');
  if (deletions.length) {
    const ok = await vscode.window.showWarningMessage(`Delete ${deletions.length} file(s)?`, { modal: true, detail: deletions.map((d) => d.rel).slice(0, 15).join('\n') }, 'Delete');
    if (!ok) return;
  }
  const root = await s.conns.get(p).root();
  await runBatch(s, p, title, chosen, (i) => i.rel, async (i) => {
    const remotePath = remoteJoin(root, i.rel);
    const local = i.local?.fsPath ?? localFor(p, root, remotePath)!;
    switch (i.action) {
      case 'upload':
        return uploadFile(s, p, local);
      case 'download':
        if (isDirty(local)) throw new Error('has unsaved changes');
        return downloadFile(s, p, remotePath, local);
      case 'deleteRemote':
        return deleteRemote(s, p, { path: remotePath, kind: 'file' });
      case 'deleteLocal':
        await vscode.workspace.fs.delete(vscode.Uri.file(local), { useTrash: true });
        log.info(`Moved ${local} to trash`);
    }
  });
}

function pickPlan(s: Services, p: Profile, title: string, items: PlanItem[]): Promise<PlanItem[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<PlanItem>();
    const compare: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Compare server and local' };
    qp.title = `${title}: ${items.length} difference(s)`;
    qp.placeholder = 'Selected items will be transferred. ⚠ items are unselected by default. Enter to run.';
    qp.canSelectMany = true;
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;
    qp.items = items.map((i) => ({ ...i, buttons: i.local && i.remote ? [compare] : [] }));
    qp.selectedItems = qp.items.filter((i) => i.recommended);
    let result: PlanItem[] | undefined;
    qp.onDidTriggerItemButton(async ({ item }) => {
      if (!item.local || !item.remote) return;
      await vscode.commands.executeCommand('vscode.diff', remoteUri(p, item.remote.path), vscode.Uri.file(item.local.fsPath), `${posix.basename(item.rel)} (Server ↔ Local)`, { preview: true, preserveFocus: true });
    });
    qp.onDidAccept(() => {
      result = [...qp.selectedItems];
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(result);
    });
    qp.show();
  });
}

/** Opens a diff of the server copy (left) against the local file (right). */
export async function diffWithRemote(s: Services, p: Profile, local: string): Promise<void> {
  const rel = relativeLocal(p, local);
  if (rel === undefined) return;
  const conn = s.conns.get(p);
  const [remotePath, exists] = await conn.run(async (c, root) => {
    const rp = remoteJoin(root, rel);
    return [rp, !!(await c.stat(rp))] as const;
  });
  if (!exists) {
    void vscode.window.showInformationMessage(`${rel} does not exist on ${p.name} yet.`);
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', remoteUri(p, remotePath), vscode.Uri.file(local), `${path.basename(local)} (${p.name} ↔ Local)`);
}
