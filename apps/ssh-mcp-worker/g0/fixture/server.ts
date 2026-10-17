import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { constants } from 'node:fs';

const require = createRequire(import.meta.url);
const Protocol = require('ssh2/lib/protocol/Protocol.js') as {
  prototype: { channelData: (chan: number, data: Buffer | string) => void };
};
const plainSftpVersion = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);
const posixRenameVersion = (() => {
  const name = Buffer.from('posix-rename@openssh.com');
  const extensionData = Buffer.from('1');
  const bodyLength = 1 + 4 + 4 + name.length + 4 + extensionData.length;
  const packet = Buffer.alloc(4 + bodyLength);
  let offset = 0;
  packet.writeUInt32BE(bodyLength, offset); offset += 4;
  packet.writeUInt8(2, offset); offset += 1;
  packet.writeUInt32BE(3, offset); offset += 4;
  packet.writeUInt32BE(name.length, offset); offset += 4;
  name.copy(packet, offset); offset += name.length;
  packet.writeUInt32BE(extensionData.length, offset); offset += 4;
  extensionData.copy(packet, offset);
  return packet;
})();
const originalChannelData = Protocol.prototype.channelData;
Protocol.prototype.channelData = function (chan: number, data: Buffer | string) {
  if (Buffer.isBuffer(data) && data.equals(plainSftpVersion)) data = posixRenameVersion;
  return originalChannelData.call(this, chan, data);
};

const port = Number(process.env.FIXTURE_PORT ?? 22222);
const hostKey = readFileSync(process.env.FIXTURE_HOST_KEY!, 'utf8');
const authorizedPublicKey = utils.parseKey(readFileSync(process.env.FIXTURE_USER_PUBLIC_KEY!, 'utf8'));
if (Array.isArray(authorizedPublicKey) || authorizedPublicKey instanceof Error) throw new Error('invalid fixture public key');
const expectedKeyBytes = authorizedPublicKey.getPublicSSH();
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const log = (event: string) => appendFileSync(process.env.FIXTURE_AUTH_LOG!, `${event}\n`);
const remoteFiles = new Map<string, Buffer>([
  ['/fixture/hello.txt', Buffer.from('héllo SSH\n')],
  ['/fixture/out.txt', Buffer.alloc(0)],
  ['/fixture/binary.bin', Buffer.from([0xff, 0xfe, 0xfd])],
  ['/fixture/big.txt', Buffer.alloc(64 * 1024 + 1, 0x61)],
  ['/fixture/envelope.txt', Buffer.alloc(65_000, 0x61)],
]);
const remoteDirs = new Set<string>();

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return '/';
  return path.slice(0, slash);
}

function pathKind(path: string): 'file' | 'directory' | 'missing' {
  if (path === '/' || path === '/fixture' || path === '/fixture/many' || remoteDirs.has(path)) return 'directory';
  if (remoteFiles.has(path)) return 'file';
  return 'missing';
}

function directChildren(directory: string): Array<{ name: string; kind: 'file' | 'directory'; size: number }> {
  const prefix = `${directory}/`;
  const entries = new Map<string, { name: string; kind: 'file' | 'directory'; size: number }>();
  for (const file of remoteFiles.keys()) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.length === 0 || name.includes('/')) continue;
    entries.set(name, { name, kind: 'file', size: remoteFiles.get(file)?.length ?? 0 });
  }
  for (const dir of remoteDirs) {
    if (!dir.startsWith(prefix)) continue;
    const name = dir.slice(prefix.length);
    if (name.length === 0 || name.includes('/')) continue;
    entries.set(name, { name, kind: 'directory', size: 0 });
  }
  return [...entries.values()];
}

function moveEntry(from: string, to: string): void {
  if (remoteFiles.has(from)) {
    const data = remoteFiles.get(from) ?? Buffer.alloc(0);
    remoteFiles.delete(from);
    remoteFiles.set(to, data);
    return;
  }
  remoteDirs.delete(from);
  remoteDirs.add(to);
  for (const file of [...remoteFiles.keys()]) {
    if (!file.startsWith(`${from}/`)) continue;
    const data = remoteFiles.get(file) ?? Buffer.alloc(0);
    remoteFiles.delete(file);
    remoteFiles.set(`${to}${file.slice(from.length)}`, data);
  }
  for (const dir of [...remoteDirs]) {
    if (!dir.startsWith(`${from}/`)) continue;
    remoteDirs.delete(dir);
    remoteDirs.add(`${to}${dir.slice(from.length)}`);
  }
}

function renameEntry(from: string, to: string, overwrite: boolean): number {
  if (from === '/fixture' || from === '/fixture/many' || to === '/' || to === '/fixture' || to === '/fixture/many') {
    return STATUS_CODE.PERMISSION_DENIED;
  }
  if (pathKind(from) === 'missing') return STATUS_CODE.NO_SUCH_FILE;
  if (from === to) return STATUS_CODE.OK;
  if (pathKind(parentPath(to)) !== 'directory') return STATUS_CODE.NO_SUCH_FILE;
  if (to.startsWith(`${from}/`)) return STATUS_CODE.FAILURE;
  const destination = pathKind(to);
  if (destination !== 'missing') {
    if (!overwrite) return STATUS_CODE.FAILURE;
    if (destination === 'directory' && directChildren(to).length > 0) return STATUS_CODE.FAILURE;
    if (destination === 'directory') remoteDirs.delete(to);
    else remoteFiles.delete(to);
  }
  moveEntry(from, to);
  return STATUS_CODE.OK;
}

function readSshString(data: Buffer, offset: number): { value: string; offset: number } | undefined {
  if (offset + 4 > data.length) return undefined;
  const length = data.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) return undefined;
  return { value: data.toString('utf8', start, end), offset: end };
}

let connectionSequence = 0;
const ptyResetAllowed = (connectionId: number): boolean => {
  const file = process.env.FIXTURE_RESET_ALLOW;
  if (!file) return false;
  try {
    return readFileSync(file, 'utf8').split(/\s+/).includes(String(connectionId));
  } catch {
    return false;
  }
};
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  const connectionId = ++connectionSequence;
  let expectedRuntimeReset = false;
  let intentionalPtyReset = false;
  client.on('close', () => log(`connection-closed:${connectionId}`));
  client.on('error', (error: NodeJS.ErrnoException) => {
    if (expectedRuntimeReset && error.code === 'ECONNRESET') {
      log(`expected-runtime-reset:${connectionId}`);
      return;
    }
    if (error.code === 'ECONNRESET' && (intentionalPtyReset || ptyResetAllowed(connectionId))) {
      log(`allowed-pty-reset:${connectionId}`);
      return;
    }
    log(`unexpected-fixture-error:${connectionId}:${error.code ?? 'unknown'}`);
    throw error;
  });
  client.on('authentication', (context) => {
    if (context.method === 'none') {
      appendFileSync(process.env.FIXTURE_AUTH_LOG!, 'none\n');
      return context.reject(['password', 'publickey']);
    }
    if (context.username !== 'fixture') return context.reject();
    if (context.method === 'password') {
      appendFileSync(process.env.FIXTURE_AUTH_LOG!, 'password\n');
      return context.password === process.env.FIXTURE_PASSWORD ? context.accept() : context.reject();
    }
    if (context.method === 'publickey') {
      if (!context.key.data.equals(expectedKeyBytes)) {
        appendFileSync(process.env.FIXTURE_AUTH_LOG!, context.signature ? 'publickey-wrong-signature\n' : 'publickey-wrong-query\n');
        return context.reject();
      }
      if (!context.signature) {
        appendFileSync(process.env.FIXTURE_AUTH_LOG!, 'publickey-query\n');
        return context.accept();
      }
      appendFileSync(process.env.FIXTURE_AUTH_LOG!, 'publickey-signed\n');
      return authorizedPublicKey.verify(context.blob, context.signature, context.hashAlgo) === true
        ? context.accept()
        : context.reject();
    }
    return context.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      let ptyRequested = false;
      let term = '';
      session.on('pty', (accept, _reject, info: { term?: string }) => {
        ptyRequested = true;
        term = info?.term ?? '';
        log(`pty-connection:${connectionId}`);
        log(`pty-request:${term}`);
        if (term === 'fixture-disconnect' || term === 'fixture-interrupt') intentionalPtyReset = true;
        accept();
      });
      session.on('shell', (accept, reject) => {
        if (!ptyRequested) return reject();
        if (term === 'fixture-stall-shell') {
          log('shell-stall');
          return;
        }
        const channel = accept();
        log('shell-open');
        if (term === 'fixture-flood') {
          const payload = Buffer.alloc(300 * 1024, 0x61);
          payload.write('FLOOD-END', payload.length - 'FLOOD-END'.length);
          channel.write(payload);
        } else {
          channel.write('fixture-shell-ready\n');
          if (term === 'fixture-disconnect') {
            intentionalPtyReset = true;
            setTimeout(() => client.end(), 20);
          }
        }
        channel.on('data', (data: Buffer) => {
          log(`shell-input:${createHash('sha256').update(data).digest('hex')}`);
          const input = data.toString();
          if (input.includes('hello from client')) channel.write('fixture says hello\r\n');
          if (input.includes('disconnect shell')) client.end();
        });
        channel.on('close', () => log('shell-channel-closed'));
      });
      session.on('exec', (acceptCommand, reject, info) => {
        log(`exec-command:${info.command}`);
        if (info.command === 'fixture-disconnect') {
          client.end();
          return;
        }
        if (!['fixture-output', 'fixture-output-large', 'fixture-timeout', 'fixture-stalled-exec-ack', 'fixture-live-long-running'].includes(info.command)) return reject();
        if (info.command === 'fixture-stalled-exec-ack') {
          log(`stalled-ack-open:${connectionId}`);
          return;
        }
        const stream = acceptCommand();
        if (info.command === 'fixture-live-long-running') {
          expectedRuntimeReset = true;
          log(`live-command-started:${connectionId}`);
          stream.write('synthetic command remains in flight\n');
          return;
        }
        if (info.command === 'fixture-timeout') return;
        if (info.command === 'fixture-output-large') {
          stream.write('x'.repeat(20_000));
          stream.exit(0);
          stream.end();
          return;
        }
        stream.write('fixture stdout\n');
        stream.stderr.write('fixture stderr\n');
        stream.exit(7);
        stream.end();
      });
      session.on('sftp', (accept) => {
        log('sftp-subsystem');
        const sftp = accept();
        let nextHandle = 1;
        const files = new Map<number, { path: string; data: Buffer; writable: boolean }>();
        const dirs = new Map<number, boolean | 'many' | 'created'>();
        const createdDirPaths = new Map<number, string>();
        const toHandle = (id: number) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(id); return handle; };
        const fromHandle = (handle: Buffer) => handle.length === 4 ? handle.readUInt32BE() : -1;
        const stalled = (path: string, marker: string) => {
          if (path !== marker) return false;
          log(`${marker === '/fixture/stall-rename' ? 'sftp-stall-rename' : marker === '/fixture/stall-delete' ? 'sftp-stall-delete' : 'sftp-stall-mkdir'}:${connectionId}`);
          return true;
        };
        sftp.on('OPENDIR', (reqid, path) => {
          log(`sftp-opendir:${path}`);
          if (path === '/fixture/disconnect') {
            setTimeout(() => client.end(), 10);
            return;
          }
          if (path === '/fixture/stall') {
            log(`sftp-stall:${connectionId}`);
            return;
          }
          if (remoteDirs.has(path)) {
            const id = nextHandle++;
            dirs.set(id, 'created');
            createdDirPaths.set(id, path);
            sftp.handle(reqid, toHandle(id));
            return;
          }
          if (path !== '/fixture' && path !== '/fixture/many') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const id = nextHandle++;
          dirs.set(id, path === '/fixture/many' ? 'many' : false);
          sftp.handle(reqid, toHandle(id));
        }).on('READDIR', (reqid, handle) => {
          log('sftp-readdir');
          const id = fromHandle(handle);
          const state = dirs.get(id);
          if (state === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (state === true) return sftp.status(reqid, STATUS_CODE.EOF);
          dirs.set(id, true);
          if (state === 'many') {
            const entries = Array.from({ length: 101 }, (_, index) => ({
              filename: `item-${index}.txt`, longname: `item-${index}.txt`, attrs: { mode: constants.S_IFREG | 0o644, size: 1 },
            }));
            sftp.name(reqid, entries);
            return;
          }
          if (state === 'created') {
            const children = directChildren(createdDirPaths.get(id) ?? '');
            if (children.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.name(reqid, children.map(child => ({
              filename: child.name,
              longname: child.name,
              attrs: {
                mode: (child.kind === 'directory' ? constants.S_IFDIR | 0o755 : constants.S_IFREG | 0o644),
                size: child.size,
              },
            })));
            return;
          }
          sftp.name(reqid, [{ filename: 'hello.txt', longname: 'hello.txt', attrs: { mode: constants.S_IFREG | 0o644, size: 10 } }]);
        }).on('OPEN', (reqid, path, flags) => {
          const isWrite = Boolean(flags & OPEN_MODE.WRITE);
          const creating = Boolean(flags & OPEN_MODE.CREAT);
          const exclusive = Boolean(flags & OPEN_MODE.EXCL);
          const truncating = Boolean(flags & OPEN_MODE.TRUNC);
          if (remoteFiles.has(path) && creating && exclusive) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (!remoteFiles.has(path)) {
            if (!creating) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            remoteFiles.set(path, Buffer.alloc(0));
          }
          if (path === '/fixture/hello.txt' && isWrite) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          let data = Buffer.from(remoteFiles.get(path) ?? Buffer.alloc(0));
          if (isWrite && truncating) {
            data = Buffer.alloc(0);
            remoteFiles.set(path, data);
          }
          const id = nextHandle++;
          files.set(id, { path, data, writable: isWrite });
          log(`sftp-open:${path}`);
          sftp.handle(reqid, toHandle(id));
        }).on('READ', (reqid, handle, offset, length) => {
          const file = files.get(fromHandle(handle));
          if (!file || file.writable) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (offset >= file.data.length) return sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, file.data.subarray(offset, Math.min(offset + length, file.data.length)));
        }).on('WRITE', (reqid, handle, offset, data) => {
          const file = files.get(fromHandle(handle));
          if (!file || !file.writable) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (file.path === '/fixture/drop-write') {
            intentionalPtyReset = true;
            log(`sftp-write-drop:${connectionId}`);
            client.end();
            return;
          }
          if (file.path === '/fixture/stall-write') {
            log(`sftp-stall-write:${connectionId}`);
            return;
          }
          const next = Buffer.alloc(Math.max(file.data.length, offset + data.length));
          file.data.copy(next);
          data.copy(next, offset);
          file.data = next;
          remoteFiles.set(file.path, Buffer.from(next));
          log(`sftp-write:${file.path}:${data.length}`);
          sftp.status(reqid, STATUS_CODE.OK);
        }).on('CLOSE', (reqid, handle) => {
          const id = fromHandle(handle);
          if (!files.delete(id) && !dirs.delete(id)) return sftp.status(reqid, STATUS_CODE.FAILURE);
          log(`sftp-close:${id}`);
          sftp.status(reqid, STATUS_CODE.OK);
        }).on('REMOVE', (reqid, path) => {
          if (path === '/fixture/drop-delete') {
            intentionalPtyReset = true;
            log(`sftp-delete-drop:${connectionId}`);
            client.end();
            return;
          }
          if (stalled(path, '/fixture/stall-delete')) return;
          if (pathKind(path) === 'missing') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          if (pathKind(path) !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
          remoteFiles.delete(path);
          log(`sftp-delete:file:${path}`);
          sftp.status(reqid, STATUS_CODE.OK);
        }).on('RMDIR', (reqid, path) => {
          if (path === '/fixture' || path === '/fixture/many') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          const kind = pathKind(path);
          if (kind === 'missing') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          if (kind !== 'directory' || directChildren(path).length > 0) return sftp.status(reqid, STATUS_CODE.FAILURE);
          remoteDirs.delete(path);
          log(`sftp-delete:empty_directory:${path}`);
          sftp.status(reqid, STATUS_CODE.OK);
        }).on('MKDIR', (reqid, path) => {
          if (path === '/fixture/drop-mkdir') {
            intentionalPtyReset = true;
            log(`sftp-mkdir-drop:${connectionId}`);
            client.end();
            return;
          }
          if (stalled(path, '/fixture/stall-mkdir')) return;
          if (pathKind(path) !== 'missing') return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (pathKind(parentPath(path)) !== 'directory') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          remoteDirs.add(path);
          log(`sftp-mkdir:${path}`);
          sftp.status(reqid, STATUS_CODE.OK);
        }).on('RENAME', (reqid, oldPath, newPath) => {
          if (oldPath === '/fixture/drop-rename' || newPath === '/fixture/drop-rename') {
            intentionalPtyReset = true;
            log(`sftp-rename-drop:${connectionId}`);
            client.end();
            return;
          }
          if (stalled(oldPath, '/fixture/stall-rename') || stalled(newPath, '/fixture/stall-rename')) return;
          const code = renameEntry(oldPath, newPath, false);
          if (code === STATUS_CODE.OK) log(`sftp-rename:${oldPath}:${newPath}`);
          sftp.status(reqid, code);
        }).on('EXTENDED', (reqid, requestName, requestData) => {
          if (requestName !== 'posix-rename@openssh.com' || !Buffer.isBuffer(requestData)) {
            return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
          }
          const source = readSshString(requestData, 0);
          const destination = source ? readSshString(requestData, source.offset) : undefined;
          if (!source || !destination || destination.offset !== requestData.length) {
            return sftp.status(reqid, STATUS_CODE.BAD_MESSAGE);
          }
          if (source.value === '/fixture/drop-rename' || destination.value === '/fixture/drop-rename') {
            intentionalPtyReset = true;
            log(`sftp-rename-drop:${connectionId}`);
            client.end();
            return;
          }
          if (stalled(source.value, '/fixture/stall-rename') || stalled(destination.value, '/fixture/stall-rename')) return;
          const code = renameEntry(source.value, destination.value, true);
          if (code === STATUS_CODE.OK) log(`sftp-rename:${source.value}:${destination.value}`);
          sftp.status(reqid, code);
        }).on('REALPATH', (reqid, path) => {
          sftp.name(reqid, [{ filename: path, longname: path, attrs: {} }]);
        });
        sftp.on('close', () => log(`sftp-session-closed:open-files=${files.size}:open-dirs=${dirs.size}`));
      });
    });
  });
});

const probe = createNetServer();
probe.once('error', (error) => { throw error; });
probe.listen(port, '127.0.0.1', () => probe.close(() => {
  server.listen(port, '0.0.0.0', () => process.stdout.write(`fixture sshd listening ${port}\n`));
}));
