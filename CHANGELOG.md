# Changelog

## 0.3.0

- Download on open is now on by default (`sftpPlus.downloadOnOpen`). It asks instead when the local copy has changes the server doesn't.
- Publisher is now Aman Azkar (`amanazkar.sftp-plus`).

## 0.2.0

- Opening a file checks the server copy and offers Download / Compare / Keep Mine when it differs; `downloadOnOpen` does it automatically. Identical files get a baseline, so conflict detection covers them from the first save.

## 0.1.0

- First release: SFTP/FTP/FTPS, upload on save with conflict detection, remote explorer with drag & drop, previewed sync, keychain-backed credentials, host key verification, sftp.json compatibility.
