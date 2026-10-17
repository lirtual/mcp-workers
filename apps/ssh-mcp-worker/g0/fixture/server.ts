import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';

const port = Number(process.env.FIXTURE_PORT ?? 22222);
const hostKey = readFileSync(process.env.FIXTURE_HOST_KEY!, 'utf8');
const authorizedPublicKey = utils.parseKey(readFileSync(process.env.FIXTURE_USER_PUBLIC_KEY!, 'utf8'));
if (Array.isArray(authorizedPublicKey) || authorizedPublicKey instanceof Error) throw new Error('invalid fixture public key');
const expectedKeyBytes = authorizedPublicKey.getPublicSSH();

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (context) => {
    appendFileSync(process.env.FIXTURE_AUTH_LOG!, `${context.method}\n`);
    if (context.method === 'none') return context.reject(['password', 'publickey']);
    if (context.username !== 'fixture') return context.reject();
    if (context.method === 'password') return context.accept();
    if (context.method === 'publickey' && context.key.data.equals(expectedKeyBytes)) return context.accept();
    return context.reject();
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptCommand, reject, info) => {
        if (info.command === 'fixture-disconnect') {
          client.end();
          return;
        }
        if (info.command !== 'fixture-output') return reject();
        const stream = acceptCommand();
        stream.write('fixture stdout\n');
        stream.stderr.write('fixture stderr\n');
        stream.exit(7);
        stream.end();
      });
    });
  });
});

const probe = createNetServer();
probe.once('error', (error) => { throw error; });
probe.listen(port, '127.0.0.1', () => probe.close(() => {
  server.listen(port, '0.0.0.0', () => process.stdout.write(`fixture sshd listening ${port}\n`));
}));
