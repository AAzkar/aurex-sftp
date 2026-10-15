import * as vscode from 'vscode';
import * as fs from 'fs';
import { posix } from 'path';
import { FtpRemote } from './clients/ftp';
import { keyNeedsPassphrase, SftpRemote, SftpOptions } from './clients/sftp';
import { HostKeyError, RemoteClient } from './clients/types';
import { connectionSignature, describe, Profile } from './config';
import { Credentials } from './credentials';
import { log } from './log';
import { delay, errText, isAuthError, isConnectionError, Semaphore } from './util';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

async function createClient(p: Profile, creds: Credentials): Promise<RemoteClient> {
  if (p.protocol === 'ftp') {
    return new FtpRemote({
      host: p.host,
      port: p.port,
      user: p.username,
      password: await creds.password(p),
      secure: p.secure,
      rejectUnauthorized: p.rejectUnauthorized,
      timeout: p.connectTimeout,
    });
  }
  const opts: SftpOptions = {
    host: p.host,
    port: p.port,
    username: p.username,
    readyTimeout: p.connectTimeout,
    trustedFingerprint: creds.trustedHostKey(p),
  };
  if (p.privateKeyPath) {
    opts.privateKey = await fs.promises.readFile(p.privateKeyPath);
    if (typeof p.passphrase === 'string') opts.passphrase = p.passphrase;
    else if (p.passphrase === true || keyNeedsPassphrase(opts.privateKey)) opts.passphrase = await creds.passphrase(p);
  } else if (p.agent) {
    opts.agent = p.agent;
  } else {
    opts.password = await creds.password(p);
  }
  return new SftpRemote(opts);
}

/**
 * One logical connection to a server. Operations go through `run`, which connects on demand,
 * limits concurrency (SFTP pipelines several requests; FTP can only do one at a time),
 * and reconnects + retries when the connection drops mid-operation.
 */
export class Connection implements vscode.Disposable {
  private client?: RemoteClient;
  private connecting?: Promise<RemoteClient>;
  private remoteRoot = '/';
  private readonly gate: Semaphore;
  private idleTimer?: NodeJS.Timeout;
  private active = 0;
  state: ConnectionState = 'disconnected';

  constructor(
    public profile: Profile,
    private readonly creds: Credentials,
    private readonly onState: (c: Connection) => void,
  ) {
    this.gate = new Semaphore(profile.protocol === 'sftp' ? profile.concurrency : 1);
  }

  /** Runs `fn` with a live client and the absolute remote root of this profile. */
  run<T>(fn: (client: RemoteClient, root: string) => Promise<T>): Promise<T> {
    return this.gate.use(async () => {
      this.active++;
      clearTimeout(this.idleTimer);
      try {
        const retries = vscode.workspace.getConfiguration('sftpPlus').get<number>('retries', 2);
        for (let attempt = 0; ; attempt++) {
          const client = await this.ensure();
          try {
            return await fn(client, this.remoteRoot);
          } catch (err) {
            if (client.isAlive() && !isConnectionError(err)) throw err;
            this.drop(client);
            if (attempt >= retries) throw err;
            log.warn(`${this.profile.name}: connection lost (${errText(err)}); reconnecting, attempt ${attempt + 1} of ${retries}`);
            await delay(500 * 2 ** attempt);
          }
        }
      } finally {
        this.active--;
        this.scheduleIdle();
      }
    });
  }

  /** The absolute remote root (connects if needed). */
  root(): Promise<string> {
    return this.run(async (_c, root) => root);
  }

  private ensure(): Promise<RemoteClient> {
    if (this.client?.isAlive()) return Promise.resolve(this.client);
    if (this.client) this.drop(this.client); // died while idle
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<RemoteClient> {
    const p = this.profile;
    this.setState('connecting');
    try {
      for (let attempt = 0; ; attempt++) {
        const client = await createClient(p, this.creds);
        log.info(`Connecting to ${p.name} (${describe(p)})`);
        try {
          await client.connect();
        } catch (err) {
          await client.close().catch(() => undefined);
          if (err instanceof HostKeyError && attempt === 0 && (await this.creds.confirmHostKey(p, err))) continue;
          if (isAuthError(err)) await this.creds.forget(p);
          log.error(`${p.name}: connect failed: ${errText(err)}`);
          throw err;
        }
        this.client = client;
        this.remoteRoot = posix.isAbsolute(p.remotePath) ? posix.normalize(p.remotePath) : posix.join(client.home, p.remotePath);
        log.info(`Connected to ${p.name}; remote root ${this.remoteRoot}`);
        this.setState('connected');
        return client;
      }
    } catch (err) {
      this.setState('disconnected');
      throw err;
    }
  }

  private drop(client: RemoteClient) {
    void client.close().catch(() => undefined);
    if (this.client === client) {
      this.client = undefined;
      this.setState('disconnected');
    }
  }

  private scheduleIdle() {
    const seconds = vscode.workspace.getConfiguration('sftpPlus').get<number>('idleDisconnectSeconds', 300);
    if (!seconds || this.active > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.active === 0 && this.client) {
        log.info(`${this.profile.name}: idle, disconnecting`);
        this.drop(this.client);
      }
    }, seconds * 1000);
  }

  private setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.onState(this);
  }

  disconnect(): void {
    clearTimeout(this.idleTimer);
    if (this.client) this.drop(this.client);
  }

  dispose(): void {
    this.disconnect();
  }
}

export class Connections implements vscode.Disposable {
  private readonly map = new Map<string, { conn: Connection; signature: string }>();
  private readonly emitter = new vscode.EventEmitter<Profile>();
  readonly onDidChangeState = this.emitter.event;

  constructor(private readonly creds: Credentials) {}

  get(p: Profile): Connection {
    const signature = connectionSignature(p);
    const existing = this.map.get(p.id);
    if (existing && existing.signature === signature) {
      existing.conn.profile = p;
      return existing.conn;
    }
    existing?.conn.dispose();
    const conn = new Connection(p, this.creds, (c) => this.emitter.fire(c.profile));
    this.map.set(p.id, { conn, signature });
    return conn;
  }

  state(p: Profile): ConnectionState {
    return this.map.get(p.id)?.conn.state ?? 'disconnected';
  }

  disconnectAll(): void {
    for (const { conn } of this.map.values()) conn.disconnect();
  }

  dispose(): void {
    for (const { conn } of this.map.values()) conn.dispose();
    this.map.clear();
    this.emitter.dispose();
  }
}
