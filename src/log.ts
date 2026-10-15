import * as vscode from 'vscode';

export const log = vscode.window.createOutputChannel('SFTP Plus', { log: true });

// Integration tests read the log from stdout.
if (process.env.SFTP_PLUS_DEBUG) {
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = log[level].bind(log);
    log[level] = (message: string, ...args: unknown[]) => {
      console.log(`[sftp-plus ${level}] ${message}`);
      original(message, ...args);
    };
  }
}
