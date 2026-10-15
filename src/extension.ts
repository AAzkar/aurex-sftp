import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posix } from 'path';
import { ConfigStore, describe, localFor, Profile, RawEntry, relativeLocal } from './config';
import { Credentials } from './credentials';
import { EntryNode, Node, ProfileNode, RemoteExplorer, uploadInto } from './explorer';
import { log } from './log';
import { RemoteFileSystem, remoteUri, SCHEME } from './remoteFs';
import { Services } from './services';
import { AutoUploader, diffWithRemote, OpenChecker, syncFolder } from './sync';
import { downloadPaths, uploadPaths, deleteRemote } from './transfer';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const config = new ConfigStore(ctx);
  const s = new Services(ctx, config);
  const explorer = new RemoteExplorer(s);
  ctx.subscriptions.push(
    log,
    config,
    s,
    explorer,
    new AutoUploader(s),
    new OpenChecker(s),
    vscode.workspace.registerFileSystemProvider(SCHEME, new RemoteFileSystem(s), { isCaseSensitive: true }),
    config.onDidChange(() => s.status.setVisible(config.profiles.length > 0)),
  );

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          await s.reportError(`Aurex SFTP`, err);
        }
      }),
    );

  /** Local files a command applies to: explorer multi-selection, the clicked file, or the active editor. */
  const localTargets = (uri?: vscode.Uri, all?: vscode.Uri[]): string[] => {
    const uris = all?.length ? all : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    return uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
  };

  /** The profile for a local path; asks when several servers map the same folder. */
  const profileFor = async (fsPath: string, purpose: string): Promise<Profile | undefined> => {
    const matches = config.forPath(fsPath);
    if (!matches.length) {
      void vscode.window.showWarningMessage(`${path.basename(fsPath)} is not inside a folder mapped in sftp.json.`);
      return undefined;
    }
    return matches.length === 1 ? matches[0] : pickProfile(matches, purpose);
  };

  const pickProfile = async (profiles: readonly Profile[], purpose: string): Promise<Profile | undefined> => {
    if (profiles.length <= 1) return profiles[0];
    const pick = await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name, description: describe(p), p })),
      { placeHolder: purpose },
    );
    return pick?.p;
  };

  /** Profile node, or a remote entry node, or ask. */
  const profileOf = async (node?: Node): Promise<Profile | undefined> =>
    node && node.type !== 'message' ? node.profile : pickProfile(config.profiles, 'Which server?');

  // ── Local file commands ───────────────────────────────────────────────────────

  register('aurexSftp.upload', async (uri?: vscode.Uri, all?: vscode.Uri[]) => {
    const targets = localTargets(uri, all);
    if (!targets.length) return;
    const p = await profileFor(targets[0], 'Upload to which server?');
    if (!p) return;
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && targets.includes(d.uri.fsPath));
    for (const d of dirty) await d.save();
    await uploadPaths(s, p, targets.filter((t) => relativeLocal(p, t) !== undefined));
    s.status.clearError();
  });

  register('aurexSftp.download', async (uri?: vscode.Uri, all?: vscode.Uri[]) => {
    const targets = localTargets(uri, all);
    if (!targets.length) return;
    const p = await profileFor(targets[0], 'Download from which server?');
    if (!p) return;
    const root = await s.conns.get(p).root();
    await downloadPaths(s, p, targets.map((t) => posix.join(root, relativeLocal(p, t) ?? '')));
  });

  register('aurexSftp.diffWithRemote', async (uri?: vscode.Uri) => {
    const [target] = localTargets(uri);
    if (!target) return;
    const p = await profileFor(target, 'Compare with which server?');
    if (p) await diffWithRemote(s, p, target);
  });

  const sync = (direction: 'up' | 'down') => async (arg?: vscode.Uri | Node) => {
    let p: Profile | undefined;
    let localDir: string | undefined;
    if (arg instanceof vscode.Uri) {
      localDir = arg.fsPath;
      p = await profileFor(localDir, 'Sync with which server?');
    } else if (arg && arg.type !== 'message') {
      p = arg.profile;
      if (arg.type === 'profile') localDir = p.localRoot;
      else {
        localDir = localFor(p, await s.conns.get(p).root(), arg.entry.path);
        if (!localDir) throw new Error(`${arg.entry.path} is outside the mapped remote folder`);
      }
    } else {
      p = await pickProfile(config.profiles, 'Sync which server?');
      localDir = p?.localRoot;
    }
    if (p && localDir) await syncFolder(s, p, localDir, direction);
  };
  register('aurexSftp.syncToRemote', sync('up'));
  register('aurexSftp.syncToLocal', sync('down'));

  // ── Remote explorer commands ──────────────────────────────────────────────────

  const selected = (node: Node | undefined, all?: Node[]): EntryNode[] =>
    (all?.length ? all : node ? [node] : explorer.view.selection).filter((n): n is EntryNode => n.type === 'entry');

  register('aurexSftp.refresh', () => explorer.refresh());
  register('aurexSftp.remote.refresh', (node?: Node) => explorer.refresh(node));

  register('aurexSftp.remote.download', async (node?: Node, all?: Node[]) => {
    const nodes = selected(node, all);
    if (!nodes.length) return;
    const p = nodes[0].profile;
    const root = await s.conns.get(p).root();
    let target: ((remotePath: string, root: string) => string | undefined) | undefined;
    if (nodes.some((n) => !localFor(p, root, n.entry.path))) {
      // Outside the mapping: ask where to put it, keeping folder structure below the picked item.
      const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Download Here' });
      if (!folder) return;
      target = (rp) => {
        const owner = nodes.find((n) => rp === n.entry.path || rp.startsWith(n.entry.path + '/'))!;
        return path.join(folder[0].fsPath, owner.entry.name, ...posix.relative(owner.entry.path, rp).split('/').filter(Boolean));
      };
      if (nodes.every((n) => n.entry.kind !== 'dir')) target = (rp) => path.join(folder[0].fsPath, posix.basename(rp));
    }
    await downloadPaths(s, p, nodes.map((n) => n.entry.path), target);
  });

  register('aurexSftp.remote.uploadHere', async (node?: ProfileNode | EntryNode) => {
    const p = await profileOf(node);
    if (!p) return;
    const dir = node ? await explorer.dirOf(node) : await s.conns.get(p).root();
    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: true, openLabel: `Upload to ${dir}` });
    if (picks?.length) await uploadInto(s, p, picks.map((u) => u.fsPath), dir);
  });

  const newItem = (kind: 'file' | 'folder') => async (node?: ProfileNode | EntryNode) => {
    const p = await profileOf(node);
    if (!p) return;
    const dir = node ? await explorer.dirOf(node) : await s.conns.get(p).root();
    const name = await vscode.window.showInputBox({
      title: `New ${kind} in ${p.name}:${dir}`,
      prompt: 'Name (use / for nested paths)',
      validateInput: (v) => (!v.trim() ? 'Enter a name' : v.includes('..') ? 'Use a name inside this folder' : undefined),
    });
    if (!name) return;
    const target = posix.join(dir, name.trim());
    const uri = remoteUri(p, target);
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      await s.conns.get(p).run(async (c) => {
        if (await c.stat(target)) throw new Error(`${target} already exists`);
        await c.mkdirp(posix.dirname(target));
        await c.writeFile(target, Buffer.alloc(0));
      });
      s.notifyRemoteChanged(p, posix.dirname(target));
      await vscode.window.showTextDocument(uri);
    }
  };
  register('aurexSftp.remote.newFile', newItem('file'));
  register('aurexSftp.remote.newFolder', newItem('folder'));

  register('aurexSftp.remote.rename', async (node?: EntryNode) => {
    const [n] = selected(node);
    if (!n) return;
    const name = await vscode.window.showInputBox({
      title: `Rename ${n.entry.path}`,
      value: n.entry.name,
      valueSelection: [0, n.entry.name.lastIndexOf('.') > 0 ? n.entry.name.lastIndexOf('.') : n.entry.name.length],
      validateInput: (v) => (!v.trim() || v.includes('/') ? 'Enter a name without slashes' : undefined),
    });
    if (!name || name === n.entry.name) return;
    const to = posix.join(posix.dirname(n.entry.path), name);
    await vscode.workspace.fs.rename(remoteUri(n.profile, n.entry.path), remoteUri(n.profile, to), { overwrite: false });
  });

  register('aurexSftp.remote.delete', async (node?: Node, all?: Node[]) => {
    const nodes = selected(node, all);
    if (!nodes.length) return;
    const p = nodes[0].profile;
    const names = nodes.map((n) => n.entry.path);
    const ok = await vscode.window.showWarningMessage(
      nodes.length === 1 ? `Delete ${names[0]} from ${p.name}?` : `Delete ${nodes.length} items from ${p.name}?`,
      { modal: true, detail: `${nodes.length > 1 ? names.slice(0, 15).join('\n') + '\n\n' : ''}This cannot be undone.${nodes.some((n) => n.entry.kind === 'dir') ? ' Folders are deleted with everything in them.' : ''}` },
      'Delete',
    );
    if (!ok) return;
    for (const n of nodes) await deleteRemote(s, p, n.entry);
    s.notifyRemoteChanged(p);
  });

  register('aurexSftp.remote.chmod', async (node?: EntryNode, all?: Node[]) => {
    const nodes = selected(node, all);
    if (!nodes.length) return;
    const current = nodes[0].entry.mode;
    const value = await vscode.window.showInputBox({
      title: `Permissions for ${nodes.length === 1 ? nodes[0].entry.name : `${nodes.length} items`}`,
      prompt: 'Octal mode, e.g. 644 for files or 755 for folders',
      value: current !== undefined ? (current & 0o777).toString(8) : nodes[0].entry.kind === 'dir' ? '755' : '644',
      validateInput: (v) => (/^[0-7]{3,4}$/.test(v) ? undefined : 'Use 3 or 4 octal digits'),
    });
    if (!value) return;
    const p = nodes[0].profile;
    await s.conns.get(p).run(async (c) => {
      for (const n of nodes) await c.chmod(n.entry.path, parseInt(value, 8));
    });
    s.notifyRemoteChanged(p);
  });

  register('aurexSftp.remote.copyPath', async (node?: Node, all?: Node[]) => {
    await vscode.env.clipboard.writeText(selected(node, all).map((n) => n.entry.path).join('\n'));
  });

  register('aurexSftp.remote.diffWithLocal', async (node?: EntryNode) => {
    const [n] = selected(node);
    if (!n) return;
    const local = localFor(n.profile, await s.conns.get(n.profile).root(), n.entry.path);
    if (!local || !fs.existsSync(local)) {
      void vscode.window.showInformationMessage(`There is no local copy of ${n.entry.name}.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', remoteUri(n.profile, n.entry.path), vscode.Uri.file(local), `${n.entry.name} (${n.profile.name} ↔ Local)`);
  });

  // ── Connection & config commands ──────────────────────────────────────────────

  register('aurexSftp.testConnection', async (node?: Node) => {
    const p = await profileOf(node);
    if (!p) return;
    const started = Date.now();
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${p.name}…` }, () =>
      s.conns.get(p).run(async (c, root) => ({ root, count: (await c.list(root)).length })),
    );
    void vscode.window.showInformationMessage(`Connected to ${p.name} in ${Date.now() - started} ms. ${result.root} has ${result.count} item(s).`);
    explorer.refresh();
  });

  register('aurexSftp.disconnect', async (node?: Node) => {
    const p = await profileOf(node);
    if (p) s.conns.get(p).disconnect();
  });
  register('aurexSftp.disconnectAll', () => s.conns.disconnectAll());
  register('aurexSftp.showLog', () => log.show());

  register('aurexSftp.openConfig', async () => {
    const folder = await pickFolder();
    if (!folder) return;
    const uri = config.configUriFor(folder);
    if (!fs.existsSync(uri.fsPath)) {
      await vscode.commands.executeCommand('aurexSftp.addServer');
      return;
    }
    await vscode.window.showTextDocument(uri);
  });

  register('aurexSftp.addServer', () => addServerWizard(config, s.creds));

  register('aurexSftp.switchProfile', async (node?: Node) => {
    const candidates = config.profiles.filter((p) => p.subProfiles.length);
    const p = node && node.type !== 'message' ? node.profile : await pickProfile(candidates, 'Switch profile for which server?');
    if (!p) return;
    if (!p.subProfiles.length) {
      void vscode.window.showInformationMessage(`${p.name} has no "profiles" in sftp.json.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      p.subProfiles.map((name) => ({ label: name, description: name === p.activeSubProfile ? 'active' : undefined })),
      { placeHolder: 'Activate profile' },
    );
    if (pick) await config.setActiveSubProfile(p, pick.label);
  });

  register('aurexSftp.toggleUploadOnSave', async (node?: Node) => {
    const p = await profileOf(node);
    if (!p) return;
    await config.updateFile(p.configUri, (text) => config.setProperty(text, p.index, ['uploadOnSave'], !p.uploadOnSave));
    void vscode.window.showInformationMessage(`Upload on save is now ${p.uploadOnSave ? 'off' : 'on'} for ${p.name}.`);
  });

  register('aurexSftp.forgetPassword', async (node?: Node) => {
    const p = await profileOf(node);
    if (!p) return;
    await s.creds.forget(p);
    s.conns.get(p).disconnect();
    void vscode.window.showInformationMessage(`Forgot the saved password for ${p.name}.`);
  });

  register('aurexSftp.moveSecretsToKeychain', () => moveSecretsToKeychain(config, s.creds));

  register('aurexSftp.menu', async () => {
    s.status.clearError();
    const editor = vscode.window.activeTextEditor?.document.uri;
    const inMapping = editor?.scheme === 'file' && config.forPath(editor.fsPath).length > 0;
    const actions: { label: string; command: string; args?: unknown[] }[] = [
      ...(inMapping
        ? [
            { label: '$(cloud-upload) Upload current file', command: 'aurexSftp.upload' },
            { label: '$(cloud-download) Download current file', command: 'aurexSftp.download' },
            { label: '$(diff) Compare current file with server', command: 'aurexSftp.diffWithRemote' },
          ]
        : []),
      { label: '$(arrow-up) Sync local → server…', command: 'aurexSftp.syncToRemote' },
      { label: '$(arrow-down) Sync server → local…', command: 'aurexSftp.syncToLocal' },
      { label: '$(remote-explorer) Open Servers view', command: 'aurexSftp.remoteExplorer.focus' },
      { label: '$(save) Toggle upload on save…', command: 'aurexSftp.toggleUploadOnSave' },
      { label: '$(arrow-swap) Switch profile…', command: 'aurexSftp.switchProfile' },
      { label: '$(plug) Test connection…', command: 'aurexSftp.testConnection' },
      { label: '$(debug-disconnect) Disconnect all', command: 'aurexSftp.disconnectAll' },
      { label: '$(gear) Open sftp.json', command: 'aurexSftp.openConfig' },
      { label: '$(output) Show log', command: 'aurexSftp.showLog' },
    ];
    const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'Aurex SFTP' });
    if (pick) await vscode.commands.executeCommand(pick.command, ...(pick.args ?? []));
  });

  await config.reload();
  void suggestMigration(ctx, config);
  log.info('Aurex SFTP activated');
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showWarningMessage('Open a folder first.');
    return undefined;
  }
  return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which workspace folder?' });
}

async function addServerWizard(config: ConfigStore, creds: Credentials): Promise<void> {
  const folder = await pickFolder();
  if (!folder) return;
  const title = 'Add Server';
  const ask = (prompt: string, opts: Partial<vscode.InputBoxOptions> = {}) =>
    vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, ...opts });

  const proto = await vscode.window.showQuickPick(
    [
      { label: 'SFTP', description: 'SSH file transfer (recommended)', protocol: 'sftp', secure: undefined as unknown },
      { label: 'FTPS', description: 'FTP over TLS (explicit, port 21)', protocol: 'ftp', secure: true },
      { label: 'FTPS (implicit)', description: 'FTP over TLS, port 990', protocol: 'ftp', secure: 'implicit' },
      { label: 'FTP', description: 'Unencrypted; only on trusted networks', protocol: 'ftp', secure: false },
    ],
    { title, placeHolder: 'Protocol', ignoreFocusOut: true },
  );
  if (!proto) return;

  let host = await ask('Host name or IP', { placeHolder: 'example.com', validateInput: (v) => (v.trim() ? undefined : 'Required') });
  if (!host) return;
  host = host.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  let portFromHost: number | undefined;
  const m = /^(.*):(\d+)$/.exec(host);
  if (m) [host, portFromHost] = [m[1], Number(m[2])];
  const defPort = proto.protocol === 'sftp' ? 22 : proto.secure === 'implicit' ? 990 : 21;
  const portText = await ask('Port', { value: String(portFromHost ?? defPort), validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'Numbers only') });
  if (!portText) return;
  const username = await ask('Username', { value: proto.protocol === 'sftp' ? os.userInfo().username : '' });
  if (username === undefined) return;

  const entry: RawEntry = { name: host, host, protocol: proto.protocol, port: Number(portText), username };
  if (proto.protocol === 'ftp' && proto.secure) entry.secure = proto.secure;
  let password: string | undefined;

  const auth =
    proto.protocol === 'sftp'
      ? await vscode.window.showQuickPick(
          [
            { label: 'Password', description: 'Stored in your OS keychain', id: 'password' },
            { label: 'Private key file', description: 'e.g. ~/.ssh/id_ed25519', id: 'key' },
            { label: 'SSH agent', description: 'Use keys loaded in ssh-agent', id: 'agent' },
          ],
          { title, placeHolder: 'How do you log in?', ignoreFocusOut: true },
        )
      : { id: 'password' };
  if (!auth) return;
  if (auth.id === 'password') {
    password = await ask(`Password for ${username}@${host}`, { password: true, placeHolder: 'Saved to the OS keychain, not to sftp.json' });
    if (password === undefined) return;
  } else if (auth.id === 'key') {
    const key = await vscode.window.showOpenDialog({ title: 'Private key', defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')), canSelectMany: false });
    if (!key) return;
    entry.privateKeyPath = key[0].fsPath.startsWith(os.homedir()) ? '~' + key[0].fsPath.slice(os.homedir().length) : key[0].fsPath;
  } else {
    entry.agent = '$SSH_AUTH_SOCK';
  }

  const remotePath = await ask('Remote folder this workspace deploys to', { value: '/', placeHolder: '/var/www/html or public_html (relative = from login folder)' });
  if (remotePath === undefined) return;
  entry.remotePath = remotePath || '/';

  const context = await ask('Local folder that maps to it (relative to the workspace)', { value: '', placeHolder: 'Leave empty for the whole workspace' });
  if (context === undefined) return;
  if (context.trim() && context.trim() !== '.') entry.context = context.trim();

  const name = await ask('A name for this server', { value: host });
  if (name === undefined) return;
  entry.name = name || host;

  const onSave = await vscode.window.showQuickPick(['Yes, upload on save', 'No, I will upload manually'], { title, placeHolder: 'Upload files automatically when you save them?', ignoreFocusOut: true });
  if (!onSave) return;
  entry.uploadOnSave = onSave.startsWith('Yes');
  entry.ignore = ['.vscode', '.git', '.DS_Store', 'node_modules'];

  if (password !== undefined) {
    await creds.store({ protocol: proto.protocol as Profile['protocol'], username, host, port: Number(portText) }, password);
  }
  const uri = config.configUriFor(folder);
  await config.updateFile(uri, (text) => config.appendEntry(text, entry));
  const added = config.profiles.filter((p) => p.configUri.fsPath === uri.fsPath).at(-1);
  const choice = await vscode.window.showInformationMessage(`Added ${entry.name} to .vscode/sftp.json.`, 'Test Connection', 'Open sftp.json');
  if (choice === 'Test Connection' && added) await vscode.commands.executeCommand('aurexSftp.testConnection', { type: 'profile', profile: added });
  if (choice === 'Open sftp.json') await vscode.window.showTextDocument(uri);
}

/** Moves plain-text passwords/passphrases out of every sftp.json into SecretStorage. */
async function moveSecretsToKeychain(config: ConfigStore, creds: Credentials): Promise<void> {
  const files = [...new Set(config.profiles.map((p) => p.configUri.fsPath))];
  let moved = 0;
  for (const file of files) {
    const uri = vscode.Uri.file(file);
    const entries = config.rawEntries(uri);
    const isArray = config.profiles.some((p) => p.configUri.fsPath === file && p.index >= 0);
    const removals: (string | number)[][] = [];
    for (const [i, raw] of entries.entries()) {
      const prefix = isArray ? [i] : [];
      const variants: [RawEntry, (string | number)[] | undefined][] = [[raw, typeof raw.password === 'string' ? [...prefix, 'password'] : undefined]];
      for (const [name, sub] of Object.entries<RawEntry>(raw.profiles ?? {})) {
        variants.push([{ ...raw, ...sub }, typeof sub.password === 'string' ? [...prefix, 'profiles', name, 'password'] : undefined]);
      }
      for (const [merged, jsonPath] of variants) {
        if (typeof merged.password !== 'string') continue;
        const protocol = String(merged.protocol ?? 'sftp').toLowerCase() === 'sftp' ? 'sftp' : 'ftp';
        const port = Number(merged.port) || (protocol === 'sftp' ? 22 : merged.secure === 'implicit' ? 990 : 21);
        const username = String(merged.username ?? merged.user ?? (protocol === 'sftp' ? os.userInfo().username : 'anonymous'));
        await creds.store({ protocol, host: String(merged.host), port, username }, merged.password);
        if (jsonPath) removals.push(jsonPath);
      }
      if (typeof raw.passphrase === 'string') {
        const username = String(raw.username ?? raw.user ?? os.userInfo().username);
        await creds.store({ protocol: 'sftp', host: String(raw.host), port: Number(raw.port) || 22, username }, raw.passphrase, 'passphrase');
        removals.push([...prefix, 'passphrase']);
      }
    }
    if (!removals.length) continue;
    const unique = [...new Map(removals.map((r) => [JSON.stringify(r), r])).values()];
    moved += unique.length;
    await config.updateFile(uri, (text) => unique.reduce((t, jsonPath) => config.setProperty(t, -1, jsonPath, undefined), text));
  }
  void vscode.window.showInformationMessage(
    moved ? `Moved ${moved} secret(s) from sftp.json into your OS keychain.` : 'No plain-text passwords found in sftp.json.',
  );
}

/** One-time hints: plain-text passwords, and another SFTP extension that would double-upload. */
async function suggestMigration(ctx: vscode.ExtensionContext, config: ConfigStore): Promise<void> {
  if (!config.profiles.length) return;
  const others = ['natizyskunk.sftp', 'liximomo.sftp', 'humy2833.ftp-simple', 'ontime.ftp-sync'].filter((id) => vscode.extensions.getExtension(id));
  if (others.length && !ctx.workspaceState.get('aurexSftp.warnedOthers')) {
    await ctx.workspaceState.update('aurexSftp.warnedOthers', true);
    const pick = await vscode.window.showInformationMessage(
      `Aurex SFTP is using this workspace's sftp.json. Other FTP extensions are also enabled (${others.join(', ')}); if they upload on save too, every save is uploaded twice. Disable them for this workspace?`,
      'Show Extensions',
    );
    if (pick) await vscode.commands.executeCommand('workbench.extensions.search', others.map((id) => `@id:${id}`).join(' '));
  }
  const plain = config.profiles.filter((p) => p.password !== undefined || typeof p.passphrase === 'string');
  if (plain.length && !ctx.workspaceState.get('aurexSftp.warnedPlaintext')) {
    await ctx.workspaceState.update('aurexSftp.warnedPlaintext', true);
    const pick = await vscode.window.showWarningMessage(
      `sftp.json stores ${plain.length === 1 ? 'a password' : `${plain.length} passwords`} in plain text. Move ${plain.length === 1 ? 'it' : 'them'} to your OS keychain?`,
      'Move to Keychain',
      'Not Now',
    );
    if (pick === 'Move to Keychain') await vscode.commands.executeCommand('aurexSftp.moveSecretsToKeychain');
  }
}
