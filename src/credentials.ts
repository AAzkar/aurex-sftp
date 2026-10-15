import * as vscode from 'vscode';
import { HostKeyError } from './clients/types';
import { Profile } from './config';

type Target = Pick<Profile, 'protocol' | 'username' | 'host' | 'port'>;
type SecretKind = 'password' | 'passphrase';

const HOST_KEYS = 'sftpPlus.hostKeys';

/** Passwords live in VS Code SecretStorage (the OS keychain); trusted SSH host keys in global state. */
export class Credentials {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  static key(t: Target, kind: SecretKind = 'password'): string {
    return `sftpPlus:${kind}:${t.protocol}://${t.username}@${t.host}:${t.port}`;
  }

  store(t: Target, value: string, kind: SecretKind = 'password'): Thenable<void> {
    return this.ctx.secrets.store(Credentials.key(t, kind), value);
  }

  async forget(t: Target): Promise<void> {
    await this.ctx.secrets.delete(Credentials.key(t, 'password'));
    await this.ctx.secrets.delete(Credentials.key(t, 'passphrase'));
  }

  /** sftp.json value, then keychain, then ask (and remember in the keychain). */
  async password(p: Profile): Promise<string> {
    if (p.password !== undefined) return p.password;
    return this.secret(p, 'password', `Password for ${p.username}@${p.host}`);
  }

  async passphrase(p: Profile): Promise<string> {
    if (typeof p.passphrase === 'string') return p.passphrase;
    return this.secret(p, 'passphrase', `Passphrase for ${p.privateKeyPath}`);
  }

  private async secret(p: Profile, kind: SecretKind, prompt: string): Promise<string> {
    const saved = await this.ctx.secrets.get(Credentials.key(p, kind));
    if (saved !== undefined) return saved;
    const value = await vscode.window.showInputBox({
      title: `SFTP Plus: ${p.name}`,
      prompt,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Saved to your OS keychain, not to sftp.json',
    });
    if (value === undefined) throw new Error('Login cancelled');
    await this.store(p, value, kind);
    return value;
  }

  trustedHostKey(p: Profile): string | undefined {
    return this.ctx.globalState.get<Record<string, string>>(HOST_KEYS, {})[`${p.host}:${p.port}`];
  }

  /** Asks the user whether to trust an unknown or changed host key; remembers it if they do. */
  async confirmHostKey(p: Profile, err: HostKeyError): Promise<boolean> {
    const changed = !!err.expected;
    const message = changed
      ? `WARNING: the SSH host key for ${p.host} has changed.`
      : `First connection to ${p.host}:${p.port}. Trust this server?`;
    const detail = changed
      ? `Expected: ${err.expected}\nReceived: ${err.fingerprint}\n\nThis happens when a server is rebuilt or moved, but it can also mean someone is intercepting the connection. Continue only if you know why the key changed.`
      : `Server fingerprint:\n${err.fingerprint}\n\nIf your host publishes its fingerprint, check that it matches.`;
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, changed ? 'Trust New Key' : 'Trust and Connect');
    if (!choice) return false;
    const keys = this.ctx.globalState.get<Record<string, string>>(HOST_KEYS, {});
    await this.ctx.globalState.update(HOST_KEYS, { ...keys, [`${p.host}:${p.port}`]: err.fingerprint });
    return true;
  }
}
