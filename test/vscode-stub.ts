// Just enough of the `vscode` module for exercising Connection outside the extension host.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => undefined };
  };
  fire(e: T) {
    this.listeners.forEach((l) => l(e));
  }
  dispose() {
    this.listeners = [];
  }
}

export const workspace = {
  getConfiguration: () => ({ get: <T>(_key: string, def: T) => (_key === 'idleDisconnectSeconds' ? (0 as T) : def) }),
};

const logLine =
  (level: string) =>
  (...args: unknown[]) =>
    process.env.VERBOSE && console.log(`  [${level}]`, ...args);
export const window = {
  createOutputChannel: () => ({ info: logLine('info'), warn: logLine('warn'), error: logLine('error'), show: () => undefined }),
};
