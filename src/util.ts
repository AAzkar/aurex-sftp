import { HostKeyError } from './clients/types';

export class Semaphore {
  private waiters: (() => void)[] = [];

  constructor(private free: number) {}

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight. `fn` should handle its own errors. */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const code = (err: unknown): unknown => (err as { code?: unknown } | undefined)?.code;

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isNotFound(err: unknown): boolean {
  const c = code(err);
  return c === 2 || c === 550 || c === 'ENOENT' || /no such file|not found/i.test(errText(err));
}

export function isAuthError(err: unknown): boolean {
  return (
    code(err) === 530 ||
    /authentication methods failed|authentication failed|login incorrect|login authentication|530 /i.test(errText(err))
  );
}

/** Errors after which the connection should be thrown away and the operation retried. */
export function isConnectionError(err: unknown): boolean {
  const c = code(err);
  if (typeof c === 'string' && /^(ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|ENOTCONN|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_DESTROYED)$/.test(c)) {
    return true;
  }
  return /not connected|no response from server|channel (is )?(closed|not open)|connection (lost|closed|reset)|socket hang up|client is closed|timeout \(control socket\)|keepalive/i.test(
    errText(err),
  );
}

/** A message a person can act on, without stack traces or protocol jargon where we can avoid it. */
export function friendlyError(err: unknown): string {
  const msg = errText(err);
  const c = code(err);
  if (err instanceof HostKeyError) return 'The server host key was not trusted, so the connection was stopped.';
  if (c === 'ECONNREFUSED') return 'Connection refused. Check the host and port, and that the server is running.';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Host not found. Check the "host" in sftp.json.';
  if (c === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'Connection timed out. The server may be down or a firewall is blocking the port.';
  if (isAuthError(err)) return 'Login failed. Check the username and password or key. Any saved password has been cleared, so you will be asked again.';
  if (/certificate|self[- ]signed|altnames|UNABLE_TO_VERIFY|ERR_TLS/i.test(msg) || (typeof c === 'string' && c.startsWith('ERR_TLS'))) {
    return `TLS certificate problem (${msg}). If you trust this server, add "secureOptions": { "rejectUnauthorized": false } to its entry in sftp.json.`;
  }
  if (c === 3 || /permission denied|access denied/i.test(msg)) return `Permission denied on the server (${msg}).`;
  return msg;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : 'unknown';
}

export function formatMode(mode: number | undefined): string {
  return mode === undefined ? '' : (mode & 0o7777).toString(8).padStart(3, '0');
}
