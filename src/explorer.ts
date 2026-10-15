import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { RemoteEntry } from './clients/types';
import { describe, Profile, relativeLocal } from './config';
import { log } from './log';
import { remoteUri } from './remoteFs';
import { Services } from './services';
import { uploadPaths, walkLocal } from './transfer';
import { formatBytes, formatMode, formatTime, friendlyError, mapLimit } from './util';

export type Node = ProfileNode | EntryNode | MessageNode;

export interface ProfileNode {
  type: 'profile';
  profile: Profile;
}
export interface EntryNode {
  type: 'entry';
  profile: Profile;
  entry: RemoteEntry;
  parent: ProfileNode | EntryNode;
}
interface MessageNode {
  type: 'message';
  text: string;
  parent: ProfileNode | EntryNode;
}

const TREE_MIME = 'application/vnd.code.tree.sftpplus.remoteexplorer';

export class RemoteExplorer implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private profileNodes = new Map<string, ProfileNode>();
  /** Expanded directory nodes by "profileId|path", so a change in one directory refreshes just that node. */
  private dirNodes = new Map<string, ProfileNode | EntryNode>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  readonly view: vscode.TreeView<Node>;

  constructor(private readonly s: Services) {
    this.view = vscode.window.createTreeView('sftpPlus.remoteExplorer', {
      treeDataProvider: this,
      dragAndDropController: this,
      canSelectMany: true,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.view,
      s.config.onDidChange(() => this.refresh()),
      s.conns.onDidChangeState((p) => {
        const node = this.profileNodes.get(p.id);
        // Re-rendering a profile node re-lists it, so skip the transient "connecting" state.
        if (node && this.s.conns.state(p) !== 'connecting') this.emitter.fire(node);
      }),
      s.onDidChangeRemote(({ profile, dir }) => {
        const node = (dir && this.dirNodes.get(`${profile.id}|${dir}`)) || this.profileNodes.get(profile.id);
        if (node) this.emitter.fire(node);
      }),
    );
  }

  refresh(node?: Node): void {
    if (!node) {
      this.profileNodes.clear();
      this.dirNodes.clear();
    }
    this.emitter.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.tooltip = 'Click to retry';
      item.command = { command: 'sftpPlus.remote.refresh', title: 'Retry', arguments: [node.parent] };
      return item;
    }
    if (node.type === 'profile') {
      const p = node.profile;
      const state = this.s.conns.state(p);
      const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `profile:${p.id}`;
      item.description = `${describe(p)}${state === 'connected' ? '' : state === 'connecting' ? ' · connecting…' : ''}`;
      item.iconPath =
        state === 'connected'
          ? new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('testing.iconPassed'))
          : new vscode.ThemeIcon(state === 'connecting' ? 'loading~spin' : 'vm-outline');
      item.contextValue = state === 'connected' ? 'profile-connected' : 'profile';
      item.tooltip = new vscode.MarkdownString(
        [
          `**${p.name}**`,
          `${describe(p)}`,
          `Remote: \`${p.remotePath}\``,
          `Local: \`${vscode.workspace.asRelativePath(p.localRoot, true) || p.localRoot}\``,
          `Upload on save: ${p.uploadOnSave ? 'on' : 'off'}`,
          p.subProfiles.length ? `Profiles: ${p.subProfiles.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      return item;
    }
    const e = node.entry;
    const isDir = e.kind === 'dir';
    const item = new vscode.TreeItem(e.name, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${node.profile.id}|${e.path}`;
    item.resourceUri = remoteUri(node.profile, e.path); // gives file-type icons from the icon theme
    item.contextValue = isDir ? 'dir' : 'file';
    if (isDir) item.iconPath = e.isLink ? new vscode.ThemeIcon('file-symlink-directory') : vscode.ThemeIcon.Folder;
    else item.iconPath = e.isLink ? new vscode.ThemeIcon('file-symlink-file') : vscode.ThemeIcon.File;
    if (!isDir) {
      item.description = formatBytes(e.size);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    }
    item.tooltip = [e.path, isDir ? '' : formatBytes(e.size), `Modified ${formatTime(e.mtime)}`, e.mode !== undefined ? `Permissions ${formatMode(e.mode)}` : '']
      .filter(Boolean)
      .join('\n');
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.s.config.profiles.map((profile) => {
        const n: ProfileNode = { type: 'profile', profile };
        this.profileNodes.set(profile.id, n);
        return n;
      });
    }
    if (node.type === 'message') return [];
    if (node.type === 'entry' && node.entry.kind !== 'dir') return [];
    const p = node.profile;
    try {
      const entries = await this.s.conns.get(p).run(async (c, root) => {
        const dir = node.type === 'profile' ? root : node.entry.path;
        if (node.type === 'profile') this.dirNodes.set(`${p.id}|${root}`, node);
        return c.list(dir);
      });
      entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true }));
      return entries.map((entry) => {
        const child: EntryNode = { type: 'entry', profile: p, entry, parent: node };
        if (entry.kind === 'dir') this.dirNodes.set(`${p.id}|${entry.path}`, child);
        return child;
      });
    } catch (err) {
      log.error(`Listing on ${p.name} failed: ${err}`);
      return [{ type: 'message', text: friendlyError(err), parent: node }];
    }
  }

  getParent(node: Node): Node | undefined {
    return node.type === 'profile' ? undefined : node.parent;
  }

  /** Remote directory a node stands for (the root for profile nodes, the parent dir for files). */
  async dirOf(node: ProfileNode | EntryNode): Promise<string> {
    if (node.type === 'profile') return this.s.conns.get(node.profile).root();
    return node.entry.kind === 'dir' ? node.entry.path : posix.dirname(node.entry.path);
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const entries = source.filter((n): n is EntryNode => n.type === 'entry');
    if (!entries.length) return;
    data.set(TREE_MIME, new vscode.DataTransferItem(entries));
    // Dropping remote files onto an editor opens them.
    data.set('text/uri-list', new vscode.DataTransferItem(entries.map((n) => remoteUri(n.profile, n.entry.path).toString()).join('\r\n')));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (!target || target.type === 'message') return;
    const p = target.profile;
    const destDir = await this.dirOf(target);

    const internal = data.get(TREE_MIME)?.value as EntryNode[] | undefined;
    if (internal?.length) {
      await this.move(p, internal, destDir);
      return;
    }

    const uriList = await data.get('text/uri-list')?.asString();
    if (!uriList || token.isCancellationRequested) return;
    const locals = uriList
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => vscode.Uri.parse(l.trim()))
      .filter((u) => u.scheme === 'file')
      .map((u) => u.fsPath);
    if (locals.length) await uploadInto(this.s, p, locals, destDir);
  }

  private async move(p: Profile, nodes: EntryNode[], destDir: string) {
    const moves = nodes
      .filter((n) => n.profile.id === p.id && posix.dirname(n.entry.path) !== destDir && !destDir.startsWith(n.entry.path + '/') && destDir !== n.entry.path)
      .map((n) => ({ from: n.entry.path, to: posix.join(destDir, n.entry.name) }));
    if (!moves.length) return;
    const ok = await vscode.window.showWarningMessage(
      `Move ${moves.length === 1 ? posix.basename(moves[0].from) : `${moves.length} items`} to ${destDir} on ${p.name}?`,
      { modal: true },
      'Move',
    );
    if (!ok) return;
    try {
      await this.s.conns.get(p).run(async (c) => {
        for (const m of moves) await c.rename(m.from, m.to);
      });
    } catch (err) {
      await this.s.reportError(`Move on ${p.name} failed`, err);
    }
    this.s.notifyRemoteChanged(p);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Uploads arbitrary local files/folders into a remote directory. Files inside the profile's local
 * root that land in their mapped location go through the normal path (baselines, ignore rules);
 * anything else is copied as-is.
 */
export async function uploadInto(s: Services, p: Profile, locals: string[], destDir: string): Promise<void> {
  const conn = s.conns.get(p);
  const root = await conn.root();
  const mapped = locals.filter((l) => {
    const rel = relativeLocal(p, l);
    return rel !== undefined && posix.join(root, posix.dirname(rel)) === destDir;
  });
  if (mapped.length === locals.length) {
    await uploadPaths(s, p, locals);
    return;
  }
  const jobs: { local: string; remote: string }[] = [];
  for (const local of locals) {
    const st = await fs.promises.stat(local);
    const base = path.basename(local);
    if (st.isDirectory()) {
      // Walk with a throwaway profile rooted at the dropped folder so its own ignore rules apply.
      const files = await walkLocal({ ...p, localRoot: local }, local);
      for (const f of files) jobs.push({ local: f.fsPath, remote: posix.join(destDir, base, f.rel) });
    } else {
      jobs.push({ local, remote: posix.join(destDir, base) });
    }
  }
  const status = s.status.begin(`Uploading ${jobs.length} file(s) to ${p.name}`);
  const failures: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${p.name}:${destDir}`, cancellable: true }, async (progress, token) => {
    await mapLimit(
      jobs,
      p.protocol === 'sftp' ? p.concurrency : 1,
      async (j) => {
        try {
          await conn.run(async (c) => {
            try {
              await c.uploadFile(j.local, j.remote);
            } catch {
              await c.mkdirp(posix.dirname(j.remote));
              await c.uploadFile(j.local, j.remote);
            }
          });
        } catch (err) {
          failures.push(`${path.basename(j.local)}: ${friendlyError(err)}`);
        }
        progress.report({ increment: 100 / jobs.length, message: path.basename(j.local) });
      },
      () => token.isCancellationRequested,
    );
  });
  s.notifyRemoteChanged(p, destDir);
  if (failures.length) {
    status.fail(`${failures.length} upload(s) failed`);
    void vscode.window.showErrorMessage(`Some uploads failed: ${failures.slice(0, 3).join('; ')}`);
  } else status.ok(`Uploaded ${jobs.length} file(s) to ${p.name}`);
}
