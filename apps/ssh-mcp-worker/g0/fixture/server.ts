import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { constants } from 'node:fs';

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
]);

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
        const dirs = new Map<number, boolean>();
        const toHandle = (id: number) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(id); return handle; };
        const fromHandle = (handle: Buffer) => handle.length === 4 ? handle.readUInt32BE() : -1;
        sftp.on('OPENDIR', (reqid, path) => {
          log(`sftp-opendir:${path}`);
          if (path === '/fixture/disconnect') {
            setTimeout(() => client.end(), 10);
            return;
          }
          if (path !== '/fixture') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const id = nextHandle++;
          dirs.set(id, false);
          sftp.handle(reqid, toHandle(id));
        }).on('READDIR', (reqid, handle) => {
          log('sftp-readdir');
          const id = fromHandle(handle);
          if (!dirs.has(id)) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (dirs.get(id)) return sftp.status(reqid, STATUS_CODE.EOF);
          dirs.set(id, true);
          sftp.name(reqid, [{ filename: 'hello.txt', longname: 'hello.txt', attrs: { mode: constants.S_IFREG | 0o644, size: 10 } }]);
        }).on('OPEN', (reqid, path, flags) => {
          const isWrite = Boolean(flags & OPEN_MODE.WRITE);
          if (path !== '/fixture/hello.txt' && path !== '/fixture/out.txt') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          if (path === '/fixture/hello.txt' && isWrite) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          const id = nextHandle++;
          files.set(id, { path, data: Buffer.from(remoteFiles.get(path) ?? Buffer.alloc(0)), writable: isWrite });
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
