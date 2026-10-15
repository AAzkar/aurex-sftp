# SFTP Plus

Deploy to SFTP, FTP and FTPS servers from VS Code without the usual surprises.

- **Upload on save that you can trust.** Connections reconnect and retry when they drop. Rapid saves collapse into one upload, so two uploads of the same file never race. A failure shows a notification with a **Retry** button, never a silent miss.
- **No more overwriting someone else's fix.** SFTP Plus remembers what each file looked like on the server when you last synced it. If the server copy has changed since, it stops and offers **Compare**, **Overwrite Server** or **Use Server Version**.
- **Never edit an outdated file.** When you open a file, the server copy is checked in the background. If it's different, you're offered **Download**, **Compare** or **Keep Mine**, and by default the server version is loaded automatically (you're asked instead if your local copy has changes of its own). Matching files are recorded so conflict detection covers them from the first save.
- **A real remote explorer.** Browse servers in the sidebar. Open and edit remote files directly, drag files from Finder or the Explorer to upload, drag inside the tree to move, and rename, delete, chmod or create files and folders.
- **Sync with a preview.** *Sync Local → Server* and *Sync Server → Local* list every difference first, with a compare button on each one. Risky items (deletions, or files changed on the other side) start unticked.
- **Passwords stay out of `sftp.json`.** They're stored in the OS keychain. One command moves existing plain-text passwords there and keeps your comments and formatting. SSH host keys are verified on first connect, with a clear warning if one changes.
- **Drop-in for the Natizyskunk / liximomo SFTP extension.** It reads your existing `.vscode/sftp.json`, including `context`, `ignore`, `ignoreFile`, `profiles`/`defaultProfile`, `privateKeyPath`, `passphrase`, `agent`, `secure` and `useTempFile`.

## Getting started

1. Open a workspace. If it already has `.vscode/sftp.json`, you're done.
2. Otherwise click **SFTP Plus → +** in the activity bar, or run **SFTP Plus: Add Server…**.
3. Disable your old FTP extension for this workspace, or every save is uploaded twice. SFTP Plus offers to open it for you.

The status bar item (`☁ SFTP`) shows transfers in progress and the result. Click it for all actions.

## sftp.json

```jsonc
[
  {
    "name": "Production",
    "protocol": "sftp",            // sftp | ftp | ftps
    "host": "example.com",
    "port": 22,
    "username": "deploy",
    "privateKeyPath": "~/.ssh/id_ed25519",   // or leave out to be asked for a password (saved to the keychain)
    "remotePath": "/var/www/html",           // relative paths start from the login folder
    "context": ".",                          // local folder (relative to the workspace) that maps to remotePath
    "uploadOnSave": true,
    "ignore": [".vscode", ".git", ".DS_Store", "node_modules"],
    "profiles": {                            // optional; switch with "SFTP Plus: Switch Profile…"
      "staging": { "host": "staging.example.com" }
    },
    "defaultProfile": "staging"
  }
]
```

Extra keys SFTP Plus understands:

| Key | Default | Meaning |
| --- | --- | --- |
| `secure` | `false` | FTP only: `true` for explicit FTPS, `"implicit"` for implicit FTPS (port 990). `"protocol": "ftps"` is a shortcut. |
| `secureOptions.rejectUnauthorized` | `true` | Set to `false` for shared hosts whose TLS certificate doesn't match the hostname. |
| `password` | | Used as is, with no prompts. Leave it out to be asked once and have it saved in the OS keychain instead. |
| `downloadOnOpen` | setting | Per-server override of `sftpPlus.downloadOnOpen`. |
| `useTempFile` | `false` | Upload to a temp name, then rename, so visitors never see a half-written file. |
| `concurrency` | `4` | Parallel SFTP transfers during sync and folder uploads. FTP is always 1. |
| `connectTimeout` | `20000` | Milliseconds. |
| `agent` | | Path to an SSH agent socket, or `"$SSH_AUTH_SOCK"`. |

`.vscode/sftp.json` itself is never uploaded.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `sftpPlus.conflictDetection` | `true` | Check the server copy before upload on save. |
| `sftpPlus.checkOnOpen` | `true` | Compare opened files with the server copy. |
| `sftpPlus.downloadOnOpen` | `true` | Load the server version automatically when an opened file differs, unless your local copy has its own changes or unsaved edits. |
| `sftpPlus.retries` | `2` | Reconnect-and-retry attempts after a dropped connection. |
| `sftpPlus.idleDisconnectSeconds` | `300` | Close idle connections. `0` keeps them open. |
| `sftpPlus.showUploadNotifications` | `false` | Pop a notification on every successful upload. |

## How conflict detection works

After every upload or download, SFTP Plus records the server's size and modification time for that file in workspace state. Before the next upload on save, it compares the server copy with that record. A mismatch means something else changed the file, and you're asked what to do.

A file it has never synced is uploaded normally. A full **Sync** records every file it transfers.

Files edited directly through the remote explorer use VS Code's own "file is newer on disk" check.

## Development

```sh
npm install
npm run build        # bundle to dist/
npm test             # SFTP/FTP transports + reconnect logic against local test servers
npm run test:e2e     # runs the extension inside VS Code against a local FTP server
npm run package      # produces sftp-plus-<version>.vsix
```

Press F5 in VS Code to launch an Extension Development Host.

## Not yet

- File watcher (uploading files created or deleted outside the editor). Use **Sync** for now.
- `~/.ssh/config` host aliases and jump hosts.
- Keyboard-interactive / 2FA prompts beyond answering with the password.
