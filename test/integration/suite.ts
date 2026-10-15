// Runs inside a real VS Code extension host (see run.ts).
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const end = (doc: vscode.TextDocument) => doc.lineAt(doc.lineCount - 1).range.end;

async function waitFor(what: string, check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const remoteRoot = path.join(process.env.FTP_ROOT!, 'www');
  const results: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    results.push(`  ✓ ${name}`);
  };

  const ext = vscode.extensions.getExtension('amanazkar.sftp-plus');
  await step('extension activates from .vscode/sftp.json', async () => {
    assert.ok(ext, 'extension found');
    await ext!.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const c of ['sftpPlus.upload', 'sftpPlus.syncToRemote', 'sftpPlus.remote.delete', 'sftpPlus.addServer']) assert.ok(commands.includes(c), c);
  });

  const file = path.join(ws, 'src', 'hello.php');
  await step('upload on save creates missing remote folders', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(end(doc), ' // edited'));
    await doc.save();
    const remote = path.join(remoteRoot, 'src', 'hello.php');
    await waitFor('remote file', () => fs.existsSync(remote) && fs.readFileSync(remote, 'utf8').endsWith('// edited'));
  });

  await step('rapid saves coalesce and the last content wins', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    for (let i = 1; i <= 5; i++) {
      await editor.edit((e) => e.insert(end(doc), `\n// save ${i}`));
      await doc.save();
    }
    const remote = path.join(remoteRoot, 'src', 'hello.php');
    await waitFor('final content', () => fs.readFileSync(remote, 'utf8').endsWith('// save 5'));
  });

  await step('ignored files are not uploaded on save', async () => {
    const ignored = path.join(ws, 'node_modules', 'x.js');
    const doc = await vscode.workspace.openTextDocument(ignored);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '//'));
    await doc.save();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!fs.existsSync(path.join(remoteRoot, 'node_modules')), 'node_modules stayed local');
  });

  await step('Upload command uploads a whole folder', async () => {
    await vscode.commands.executeCommand('sftpPlus.upload', vscode.Uri.file(path.join(ws, 'assets')));
    await waitFor('folder upload', () => fs.existsSync(path.join(remoteRoot, 'assets', 'css', 'site.css')));
  });

  await step('remote files open through the sftp-plus:// file system', async () => {
    fs.writeFileSync(path.join(remoteRoot, 'server-only.txt'), 'from the server');
    const uri = vscode.Uri.from({ scheme: 'sftp-plus', authority: 'ws-test', path: '/www/server-only.txt' });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.equal(doc.getText(), 'from the server');
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.from({ scheme: 'sftp-plus', authority: 'ws-test', path: '/www' }));
    assert.deepEqual(entries.map(([n]) => n).sort(), ['assets', 'server-only.txt', 'src']);
  });

  await step('editing a remote file writes it back to the server', async () => {
    const uri = vscode.Uri.from({ scheme: 'sftp-plus', authority: 'ws-test', path: '/www/server-only.txt' });
    await vscode.workspace.fs.writeFile(uri, Buffer.from('changed in editor'));
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'server-only.txt'), 'utf8'), 'changed in editor');
  });

  await step('Download command fetches the server version', async () => {
    const local = path.join(ws, 'server-only.txt');
    fs.writeFileSync(local, 'stale');
    await vscode.commands.executeCommand('sftpPlus.download', vscode.Uri.file(local));
    assert.equal(fs.readFileSync(local, 'utf8'), 'changed in editor');
  });

  await step('sftp.json passwords move to the keychain without losing comments', async () => {
    await vscode.commands.executeCommand('sftpPlus.moveSecretsToKeychain');
    const text = fs.readFileSync(path.join(ws, '.vscode', 'sftp.json'), 'utf8');
    assert.ok(!text.includes('s3cret'), 'password removed');
    assert.ok(text.includes('// deploy target'), 'comment preserved');
    // Still connects: the password now comes from SecretStorage.
    await vscode.commands.executeCommand('sftpPlus.disconnectAll');
    await vscode.commands.executeCommand('sftpPlus.upload', vscode.Uri.file(path.join(ws, 'src', 'other.php')));
    await waitFor('upload after migration', () => fs.existsSync(path.join(remoteRoot, 'src', 'other.php')));
  });

  await step('opening an outdated file loads the server version (on by default)', async () => {
    const local = path.join(ws, 'src', 'live.php');
    fs.writeFileSync(local, '<?php // old local copy');
    fs.writeFileSync(path.join(remoteRoot, 'src', 'live.php'), '<?php // newer live version');
    const doc = await vscode.workspace.openTextDocument(local);
    await vscode.window.showTextDocument(doc);
    await waitFor('server version on disk', () => fs.readFileSync(local, 'utf8') === '<?php // newer live version');
    await waitFor('editor reloaded', () => doc.getText() === '<?php // newer live version');
  });

  await step('a local copy with its own newer changes is not overwritten', async () => {
    const local = path.join(ws, 'src', 'mine.php');
    fs.writeFileSync(path.join(remoteRoot, 'src', 'mine.php'), '<?php // server');
    await new Promise((r) => setTimeout(r, 2100));
    fs.writeFileSync(local, '<?php // my newer local work');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(local));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.readFileSync(local, 'utf8'), '<?php // my newer local work');
  });

  await step('opening an up-to-date file changes nothing', async () => {
    const local = path.join(ws, 'src', 'same.php');
    fs.writeFileSync(local, 'same');
    fs.writeFileSync(path.join(remoteRoot, 'src', 'same.php'), 'same');
    const before = fs.statSync(local).mtimeMs;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(local));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.statSync(local).mtimeMs, before, 'not re-downloaded');
  });

  console.log(results.join('\n'));
}
