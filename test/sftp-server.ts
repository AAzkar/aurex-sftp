// A small SFTP server backed by a local directory, for tests only.
import { Server, utils, Connection } from 'ssh2';
import type { Attributes } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface TestSftpServer {
  port: number;
  dropAll(): void;
  close(): Promise<void>;
}

const toAttrs = (st: fs.Stats): Attributes => ({
  mode: st.mode,
  uid: st.uid,
  gid: st.gid,
  size: st.size,
  atime: Math.floor(st.atimeMs / 1000),
  mtime: Math.floor(st.mtimeMs / 1000),
});

export function startSftpServer(root: string, user: string, pass: string): Promise<TestSftpServer> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === pass) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const files = new Map<number, number>();
          const dirs = new Map<number, { path: string; done: boolean }>();
          let next = 0;
          const local = (p: string) => path.join(root, posix.normalize('/' + p));
          const handle = (id: number) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(id);
            return b;
          };
          const id = (h: Buffer) => h.readUInt32BE(0);
          const fail = (reqid: number, err: NodeJS.ErrnoException) =>
            sftp.status(reqid, err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : err.code === 'EACCES' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, err.message);
          const guard = (reqid: number, fn: () => void) => {
            try {
              fn();
            } catch (err) {
              fail(reqid, err as NodeJS.ErrnoException);
            }
          };

          sftp.on('OPEN', (reqid, filename, flags) =>
            guard(reqid, () => {
              const fd = fs.openSync(local(filename), flagsToString(flags) ?? 'r');
              const h = next++;
              files.set(h, fd);
              sftp.handle(reqid, handle(h));
            }),
          );
          sftp.on('READ', (reqid, h, offset, length) =>
            guard(reqid, () => {
              const buf = Buffer.alloc(length);
              const n = fs.readSync(files.get(id(h))!, buf, 0, length, offset);
              if (n === 0) sftp.status(reqid, STATUS_CODE.EOF);
              else sftp.data(reqid, buf.subarray(0, n));
            }),
          );
          sftp.on('WRITE', (reqid, h, offset, data) =>
            guard(reqid, () => {
              fs.writeSync(files.get(id(h))!, data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('FSTAT', (reqid, h) => guard(reqid, () => sftp.attrs(reqid, toAttrs(fs.fstatSync(files.get(id(h))!)))));
          sftp.on('CLOSE', (reqid, h) =>
            guard(reqid, () => {
              const fd = files.get(id(h));
              if (fd !== undefined) fs.closeSync(fd);
              files.delete(id(h));
              dirs.delete(id(h));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('OPENDIR', (reqid, p) =>
            guard(reqid, () => {
              if (!fs.statSync(local(p)).isDirectory()) throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' });
              const h = next++;
              dirs.set(h, { path: p, done: false });
              sftp.handle(reqid, handle(h));
            }),
          );
          sftp.on('READDIR', (reqid, h) =>
            guard(reqid, () => {
              const d = dirs.get(id(h))!;
              if (d.done) return void sftp.status(reqid, STATUS_CODE.EOF);
              d.done = true;
              const names = fs.readdirSync(local(d.path)).map((filename) => {
                const st = fs.lstatSync(path.join(local(d.path), filename));
                return { filename, longname: filename, attrs: toAttrs(st) };
              });
              sftp.name(reqid, names);
            }),
          );
          const statLike = (follow: boolean) => (reqid: number, p: string) =>
            guard(reqid, () => sftp.attrs(reqid, toAttrs(follow ? fs.statSync(local(p)) : fs.lstatSync(local(p)))));
          sftp.on('STAT', statLike(true));
          sftp.on('LSTAT', statLike(false));
          sftp.on('REALPATH', (reqid, p) => sftp.name(reqid, [{ filename: posix.normalize('/' + (p === '.' ? '' : p)), longname: '', attrs: {} as Attributes }]));
          sftp.on('MKDIR', (reqid, p) => guard(reqid, () => (fs.mkdirSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
          sftp.on('RMDIR', (reqid, p) => guard(reqid, () => (fs.rmdirSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
          sftp.on('REMOVE', (reqid, p) => guard(reqid, () => (fs.unlinkSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
          sftp.on('RENAME', (reqid, from, to) =>
            guard(reqid, () => {
              // Plain SFTPv3 rename refuses to replace an existing target.
              if (fs.existsSync(local(to))) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
              fs.renameSync(local(from), local(to));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('SETSTAT', (reqid, p, attrs) =>
            guard(reqid, () => {
              if (attrs.mode !== undefined) fs.chmodSync(local(p), attrs.mode);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
        });
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        dropAll: () => clients.forEach((c) => c.end()),
        close: () => new Promise<void>((r) => (clients.forEach((c) => c.end()), server.close(() => r()))),
      }),
    ),
  );
}
