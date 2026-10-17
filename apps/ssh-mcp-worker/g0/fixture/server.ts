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
