import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posix } from 'path';
import ignore, { Ignore } from 'ignore';
import { applyEdits, format, FormattingOptions, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { log } from './log';

export type Protocol = 'sftp' | 'ftp';

/** One server entry, after merging the active sub-profile and filling in defaults. */
export interface Profile {
  /** Stable, URI-safe id (used as the authority of aurex-sftp:// URIs). */
  id: string;
  name: string;
  folder: vscode.WorkspaceFolder;
  configUri: vscode.Uri;
  /** Position in the config array, or -1 when sftp.json holds a single object. */
  index: number;
  /** Absolute local directory that maps to `remotePath` (workspace folder + "context"). */
  localRoot: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string | boolean;
  agent?: string;
  /** As written in the config; may be relative to the login directory. */
  remotePath: string;
  uploadOnSave: boolean;
  useTempFile: boolean;
  /** Replace the local copy automatically when the server version differs on open. */
  /** undefined = follow the aurexSftp.downloadOnOpen setting. */
  downloadOnOpen?: boolean;
  secure: boolean | 'implicit';
  rejectUnauthorized: boolean;
  connectTimeout: number;
  concurrency: number;
  subProfiles: string[];
  activeSubProfile?: string;
  ignore: Ignore;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawEntry = Record<string, any>;

const DEFAULT_IGNORE = ['.vscode', '.git', '.DS_Store'];
const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'server';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Fields that decide which server we talk to; a change in any of these means a new connection. */
export function connectionSignature(p: Profile): string {
  const { protocol, host, port, username, password, privateKeyPath, passphrase, agent, remotePath, secure, rejectUnauthorized, connectTimeout, concurrency } = p;
  return JSON.stringify({ protocol, host, port, username, password, privateKeyPath, passphrase, agent, remotePath, secure, rejectUnauthorized, connectTimeout, concurrency });
}

export function describe(p: Profile): string {
  return `${p.protocol === 'ftp' && p.secure ? 'ftps' : p.protocol}://${p.username ? p.username + '@' : ''}${p.host}${p.port === defaultPort(p.protocol, p.secure) ? '' : ':' + p.port}`;
}

function defaultPort(protocol: Protocol, secure: boolean | 'implicit'): number {
  return protocol === 'sftp' ? 22 : secure === 'implicit' ? 990 : 21;
}

/** Path of `fsPath` relative to the profile's local root ('' for the root itself), or undefined if outside. */
export function relativeLocal(p: Profile, fsPath: string): string | undefined {
  const rel = path.relative(p.localRoot, fsPath);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

export function isIgnored(p: Profile, rel: string, isDir: boolean): boolean {
  if (!rel) return false;
  return p.ignore.ignores(isDir ? rel + '/' : rel);
}

export function remoteJoin(root: string, rel: string): string {
  return rel ? posix.join(root, rel) : root;
}

/** Local path for a remote path under `root`, or undefined if it lies outside the mapping. */
export function localFor(p: Profile, root: string, remotePath: string): string | undefined {
  const rel = posix.relative(root, remotePath);
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return undefined;
  return rel ? path.join(p.localRoot, ...rel.split('/')) : p.localRoot;
}

export class ConfigStore implements vscode.Disposable {
  private list: Profile[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  /** Raw entries as last read, so commands can rewrite the file. */
  private raw = new Map<string, { text: string; data: RawEntry | RawEntry[] }>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
    const reload = () => void this.reload();
    this.disposables.push(
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload),
    );
  }

  get profiles(): readonly Profile[] {
    return this.list;
  }

  byId(id: string): Profile | undefined {
    return this.list.find((p) => p.id === id);
  }

  /** Profiles whose local root contains `fsPath`; when roots nest, only the most specific ones. */
  forPath(fsPath: string): Profile[] {
    const matches = this.list.filter((p) => relativeLocal(p, fsPath) !== undefined);
    const longest = Math.max(0, ...matches.map((p) => p.localRoot.length));
    return matches.filter((p) => p.localRoot.length === longest);
  }

  configUriFor(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'sftp.json');
  }

  rawEntries(configUri: vscode.Uri): RawEntry[] {
    const data = this.raw.get(configUri.fsPath)?.data;
    return data === undefined ? [] : Array.isArray(data) ? data : [data];
  }

  async reload(): Promise<void> {
    const profiles: Profile[] = [];
    const ids = new Set<string>();
    this.raw.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const uri = this.configUriFor(folder);
      let text: string;
      try {
        text = await fs.promises.readFile(uri.fsPath, 'utf8');
      } catch {
        continue;
      }
      const errors: ParseError[] = [];
      const data = parse(text, errors, { allowTrailingComma: true });
      if (errors.length || typeof data !== 'object' || data === null) {
        const detail = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(', ');
        log.error(`Could not parse ${uri.fsPath}: ${detail || 'expected an object or array'}`);
        void vscode.window.showWarningMessage(`Aurex SFTP: ${path.relative(folder.uri.fsPath, uri.fsPath)} has a syntax error (${detail}).`);
        continue;
      }
      this.raw.set(uri.fsPath, { text, data });
      const entries: RawEntry[] = Array.isArray(data) ? data : [data];
      entries.forEach((raw, i) => {
        const profile = this.build(raw, folder, uri, Array.isArray(data) ? i : -1);
        if (!profile) return;
        let id = profile.id;
        for (let n = 2; ids.has(id); n++) id = `${profile.id}-${n}`;
        ids.add(id);
        profiles.push({ ...profile, id });
      });
    }
    this.list = profiles;
    await vscode.commands.executeCommand('setContext', 'aurexSftp.hasConfig', profiles.length > 0);
    log.info(`Loaded ${profiles.length} server profile(s)`);
    this.emitter.fire();
  }

  private subKey(configUri: vscode.Uri, index: number) {
    return `aurexSftp.activeProfile:${configUri.fsPath}#${index}`;
  }

  async setActiveSubProfile(p: Profile, name: string): Promise<void> {
    await this.ctx.workspaceState.update(this.subKey(p.configUri, p.index), name);
    await this.reload();
  }

  private build(raw: RawEntry, folder: vscode.WorkspaceFolder, configUri: vscode.Uri, index: number): Profile | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const subProfiles = raw.profiles && typeof raw.profiles === 'object' ? Object.keys(raw.profiles) : [];
    const stored = this.ctx.workspaceState.get<string>(this.subKey(configUri, index));
    const active = [stored, raw.defaultProfile].find((n) => n && subProfiles.includes(n));
    const m: RawEntry = { ...raw, ...(active ? raw.profiles[active] : {}) };

    if (!m.host) {
      log.warn(`Skipping an entry in ${configUri.fsPath} without a "host"`);
      return undefined;
    }
    let protocol = String(m.protocol ?? 'sftp').toLowerCase();
    let secure: boolean | 'implicit' = m.secure === 'implicit' ? 'implicit' : !!m.secure;
    if (protocol === 'ftps') {
      protocol = 'ftp';
      if (m.secure === undefined) secure = true;
    }
    if (protocol !== 'sftp' && protocol !== 'ftp') {
      log.warn(`Unknown protocol "${protocol}" in ${configUri.fsPath}; expected sftp, ftp or ftps`);
      return undefined;
    }

    const ig = ignore().add(Array.isArray(m.ignore) ? m.ignore : DEFAULT_IGNORE);
    if (typeof m.ignoreFile === 'string') {
      try {
        ig.add(fs.readFileSync(path.resolve(folder.uri.fsPath, expandHome(m.ignoreFile)), 'utf8'));
      } catch (err) {
        log.warn(`Could not read ignoreFile ${m.ignoreFile}: ${err}`);
      }
    }
    // Never upload the file that holds the credentials.
    ig.add('.vscode/sftp.json');

    const name = String(m.name ?? m.host) + (active ? ` (${active})` : '');
    return {
      id: slug(`${folder.name}-${m.name ?? m.host}`),
      name,
      folder,
      configUri,
      index,
      localRoot: path.resolve(folder.uri.fsPath, m.context ?? '.'),
      protocol,
      host: String(m.host),
      port: Number(m.port) || defaultPort(protocol, secure),
      username: String(m.username ?? m.user ?? (protocol === 'sftp' ? os.userInfo().username : 'anonymous')),
      password: typeof m.password === 'string' ? m.password : undefined,
      privateKeyPath: typeof m.privateKeyPath === 'string' ? expandHome(m.privateKeyPath) : undefined,
      passphrase: m.passphrase,
      agent: typeof m.agent === 'string' ? (m.agent.includes('SSH_AUTH_SOCK') ? process.env.SSH_AUTH_SOCK : m.agent) : undefined,
      remotePath: String(m.remotePath ?? '.'),
      uploadOnSave: !!m.uploadOnSave,
      useTempFile: !!m.useTempFile,
      downloadOnOpen: typeof m.downloadOnOpen === 'boolean' ? m.downloadOnOpen : undefined,
      secure,
      rejectUnauthorized: m.secureOptions?.rejectUnauthorized !== false,
      connectTimeout: Number(m.connectTimeout) || 20_000,
      concurrency: Math.max(1, Number(m.concurrency) || 4),
      subProfiles,
      activeSubProfile: active,
      ignore: ig,
    };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * Rewrites sftp.json with jsonc-parser so comments and formatting survive.
   * `edit` gets the current text and returns the new text.
   */
  async updateFile(configUri: vscode.Uri, edit: (text: string) => string): Promise<void> {
    let text = '';
    try {
      text = await fs.promises.readFile(configUri.fsPath, 'utf8');
    } catch {
      /* new file */
    }
    const next = edit(text);
    await fs.promises.mkdir(path.dirname(configUri.fsPath), { recursive: true });
    await fs.promises.writeFile(configUri.fsPath, next, 'utf8');
    await this.reload();
  }

  /** Sets (or with `undefined`, removes) a property on one entry. `jsonPath` is relative to the entry. */
  setProperty(text: string, index: number, jsonPath: (string | number)[], value: unknown): string {
    const full = index >= 0 ? [index, ...jsonPath] : jsonPath;
    return applyEdits(text, modify(text, full, value, { formattingOptions: FORMAT }));
  }

  /** Appends an entry, turning a single-object file into an array when needed. */
  appendEntry(text: string, entry: RawEntry): string {
    const data = text.trim() ? parse(text, [], { allowTrailingComma: true }) : undefined;
    if (data === undefined) return JSON.stringify(entry, null, 2) + '\n';
    if (Array.isArray(data)) {
      return applyEdits(text, modify(text, [data.length], entry, { formattingOptions: FORMAT, isArrayInsertion: true }));
    }
    const wrapped = `[\n${text.trim()},\n${JSON.stringify(entry, null, 2)}\n]\n`;
    return applyEdits(wrapped, format(wrapped, undefined, FORMAT));
  }
}
