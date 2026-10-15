import * as vscode from 'vscode';

export const log = vscode.window.createOutputChannel('Aurex SFTP', { log: true });

// Integration tests read the log from stdout.
if (process.env.AUREX_SFTP_DEBUG) {
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = log[level].bind(log);
    log[level] = (message: string, ...args: unknown[]) => {
      console.log(`[aurex-sftp ${level}] ${message}`);
      original(message, ...args);
    };
  }
}
