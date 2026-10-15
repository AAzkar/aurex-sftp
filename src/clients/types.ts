export type EntryKind = 'file' | 'dir' | 'link';

export interface RemoteEntry {
  name: string;
  /** Absolute POSIX path on the server. */
  path: string;
  kind: EntryKind;
  /** True when the entry is a symlink; `kind` is then the kind of its target when known. */
  isLink?: boolean;
  size: number;
  /** Modification time in ms since epoch (0 when the server does not report it). */
  mtime: number;
  /** Permission bits (e.g. 0o644) when the server reports them. */
  mode?: number;
}

/**
 * The protocol-neutral surface every transport implements. All paths are absolute POSIX paths;
 * implementations are not required to be safe for concurrent use (the Connection serialises
 * access for transports that are not).
 */
export interface RemoteClient {
  /** Login directory, resolved after connect(). Used to anchor relative `remotePath`s. */
  readonly home: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
  list(dir: string): Promise<RemoteEntry[]>;
  /** Returns undefined when the path does not exist. */
  stat(path: string): Promise<RemoteEntry | undefined>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** Removes a directory and everything in it. */
  removeDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

/** Thrown by SFTP connect() when the server's host key is unknown or has changed. */
export class HostKeyError extends Error {
  constructor(
    readonly fingerprint: string,
    readonly expected?: string,
  ) {
    super(expected ? 'The server host key has changed' : 'The server host key is not trusted yet');
    this.name = 'HostKeyError';
  }
}
