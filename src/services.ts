import * as vscode from 'vscode';
import { RemoteEntry } from './clients/types';
import { ConfigStore, Profile } from './config';
import { Connections } from './connection';
import { Credentials } from './credentials';
import { log } from './log';
import { formatBytes, formatTime, friendlyError, errText } from './util';

/** What a file looked like on the server (and locally) the last time we synced it. */
export interface Baseline {
  size: number;
  mtime: number;
  localMtime?: number;
}

const BASELINES = 'aurexSftp.baselines';

export class Baselines {
  private data: Record<string, Baseline>;
  private saveTimer?: NodeJS.Timeout;

  constructor(private readonly memento: vscode.Memento) {
    this.data = memento.get<Record<string, Baseline>>(BASELINES, {});
  }

  private key(p: Profile, remotePath: string) {
    return `${p.host}:${p.port}|${remotePath}`;
  }

  get(p: Profile, remotePath: string): Baseline | undefined {
    return this.data[this.key(p, remotePath)];
  }

  set(p: Profile, remotePath: string, remote: RemoteEntry, localMtime?: number): void {
    this.data[this.key(p, remotePath)] = { size: remote.size, mtime: remote.mtime, localMtime };
    this.scheduleSave();
  }

  delete(p: Profile, remotePath: string): void {
    delete this.data[this.key(p, remotePath)];
    this.scheduleSave();
  }

  /**
   * True when the server copy no longer matches what we last synced. Some FTP listings carry no
   * usable time (mtime 0); then only the size can be compared.
   */
  static remoteChanged(remote: RemoteEntry, base: Baseline): boolean {
    return remote.size !== base.size || (!!remote.mtime && !!base.mtime && remote.mtime !== base.mtime);
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1000);
  }

  flush(): Thenable<void> {
    clearTimeout(this.saveTimer);
    return this.memento.update(BASELINES, this.data);
  }
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private running = new Map<number, string>();
  private nextId = 0;
  private flash?: { text: string; error: boolean };
  private flashTimer?: NodeJS.Timeout;

  constructor() {
    this.item.command = 'aurexSftp.menu';
    this.render();
  }

  setVisible(visible: boolean) {
    if (visible) this.item.show();
    else this.item.hide();
  }

  /** Marks an operation as running; call the returned functions when it settles. */
  begin(label: string) {
    const id = this.nextId++;
    this.running.set(id, label);
    this.render();
    const end = () => {
      this.running.delete(id);
      this.render();
    };
    return {
      ok: (message?: string) => {
        end();
        if (message) this.show(message, false, 4000);
      },
      fail: (message: string) => {
        end();
        this.show(message, true, 0);
      },
    };
  }

  private show(text: string, error: boolean, ms: number) {
    clearTimeout(this.flashTimer);
    this.flash = { text, error };
    if (ms) this.flashTimer = setTimeout(() => ((this.flash = undefined), this.render()), ms);
    this.render();
  }

  /** Briefly shows a success message. */
  note(text: string) {
    this.show(text, false, 4000);
  }

  clearError() {
    if (this.flash?.error) {
      this.flash = undefined;
      this.render();
    }
  }

  private render() {
    const labels = [...this.running.values()];
    if (labels.length) {
      this.item.text = `$(sync~spin) ${labels.length === 1 ? labels[0] : `${labels.length} transfers…`}`;
      this.item.tooltip = labels.join('\n');
      this.item.backgroundColor = undefined;
    } else if (this.flash) {
      this.item.text = `${this.flash.error ? '$(error)' : '$(check)'} ${this.flash.text}`;
      this.item.tooltip = this.flash.error ? 'Click for Aurex SFTP actions and the log' : undefined;
      this.item.backgroundColor = this.flash.error ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    } else {
      this.item.text = '$(cloud) SFTP';
      this.item.tooltip = 'Aurex SFTP: click for actions';
      this.item.backgroundColor = undefined;
    }
  }

  dispose() {
    clearTimeout(this.flashTimer);
    this.item.dispose();
  }
}

export interface RemoteChange {
  profile: Profile;
  /** Directory whose listing changed; undefined means "refresh everything for this profile". */
  dir?: string;
}

export class Services implements vscode.Disposable {
  readonly creds: Credentials;
  readonly conns: Connections;
  readonly baselines: Baselines;
  readonly status = new StatusBar();
  private readonly remoteChanged = new vscode.EventEmitter<RemoteChange>();
  readonly onDidChangeRemote = this.remoteChanged.event;

  constructor(
    readonly ctx: vscode.ExtensionContext,
    readonly config: ConfigStore,
  ) {
    this.creds = new Credentials(ctx);
    this.conns = new Connections(this.creds);
    this.baselines = new Baselines(ctx.workspaceState);
  }

  notifyRemoteChanged(profile: Profile, dir?: string) {
    this.remoteChanged.fire({ profile, dir });
  }

  /** Logs the full error and shows a short, actionable notification. */
  async reportError(what: string, err: unknown, retry?: () => unknown): Promise<void> {
    log.error(`${what}: ${errText(err)}`);
    const actions = retry ? ['Retry', 'Show Log'] : ['Show Log'];
    const choice = await vscode.window.showErrorMessage(`${what}: ${friendlyError(err)}`, ...actions);
    if (choice === 'Retry') retry?.();
    else if (choice === 'Show Log') log.show();
  }

  dispose() {
    void this.baselines.flush();
    this.conns.dispose();
    this.status.dispose();
    this.remoteChanged.dispose();
  }
}

export function describeEntry(e: { size: number; mtime: number }): string {
  return `${formatBytes(e.size)}, modified ${formatTime(e.mtime)}`;
}
