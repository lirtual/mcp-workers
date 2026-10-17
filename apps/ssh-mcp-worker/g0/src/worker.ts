import { connect, SshHostKeyError, openSftp, type SshClient, type SshChannel, type Sftp } from '@meitaim/ssh';

interface Env {
  G0_SESSIONS: DurableObjectNamespace;
}

interface ProbeRequest {
  mode: 'password' | 'privateKey' | 'disconnect' | 'sessionStart' | 'sessionWrite' | 'sessionOutput' | 'sessionClose' | 'sftpList' | 'sftpRead' | 'sftpWrite' | 'sftpMissing' | 'sftpDisconnect';
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  expectedFingerprint: string;
  command: string;
  sessionId?: string;
  input?: string;
  path?: string;
  contents?: string;
}

async function openClient(input: ProbeRequest, onHostKeyChecked?: () => void): Promise<{ client: SshClient; hostKeyChecked: boolean }> {
  let hostKeyChecked = false;
  const credential = input.mode === 'privateKey'
    ? { privateKey: input.privateKey ?? '' }
    : { password: input.password ?? '' };
  const client = await connect({
    host: input.host,
    port: input.port,
    username: input.username,
    ...credential,
    timeout: 5000,
    verifyHostKey(key) {
      hostKeyChecked = true;
      onHostKeyChecked?.();
      return key.fingerprint === input.expectedFingerprint;
    },
  });
  return { client, hostKeyChecked };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let input: ProbeRequest;
    try {
      input = await request.json<ProbeRequest>();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    if (input.mode.startsWith('session')) {
      const id = env.G0_SESSIONS.idFromName('single-g0-fixture-session');
      return env.G0_SESSIONS.get(id).fetch(new Request('https://g0-session/', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      }));
    }

    if (input.mode.startsWith('sftp')) return runSftp(input);

    let hostKeyChecked = false;
    try {
      const connected = await openClient(input, () => { hostKeyChecked = true; });
      const client = connected.client;
      hostKeyChecked = connected.hostKeyChecked;
      try {
        const result = await client.exec(input.command);
        return Response.json({
          ok: true,
          hostKeyChecked,
          fingerprint: input.expectedFingerprint,
          algorithms: client.algorithms,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
        });
      } finally {
        await client.close({ timeout: 1000 });
      }
    } catch (error) {
      return Response.json({
        ok: false,
        hostKeyChecked,
        error: error instanceof SshHostKeyError ? 'host_key_rejected' : error instanceof Error ? error.name : 'unknown',
      }, { status: 502 });
    }
  },
};

async function runSftp(input: ProbeRequest): Promise<Response> {
  let hostKeyChecked = false;
  let client: SshClient | undefined;
  let sftp: Sftp | undefined;
  try {
    const connected = await openClient(input, () => { hostKeyChecked = true; });
    client = connected.client;
    hostKeyChecked = connected.hostKeyChecked;
    if (input.mode === 'sftpDisconnect') {
      // The fixture closes the TCP/SSH connection while the SFTP request is pending.
      sftp = await openSftp(client);
      await sftp.list('/fixture/disconnect');
      throw new Error('fixture disconnect did not interrupt SFTP');
    }
    sftp = await openSftp(client);
    if (input.mode === 'sftpList') {
      const entries = await sftp.list('/fixture');
      return Response.json({ ok: true, entries: entries.map((entry) => entry.name) });
    }
    if (input.mode === 'sftpRead' || input.mode === 'sftpMissing') {
      const contents = await sftp.read(input.path ?? '/fixture/hello.txt');
      return Response.json({ ok: true, contents: new TextDecoder('utf-8', { fatal: true }).decode(contents) });
    }
    if (input.mode === 'sftpWrite') {
      await sftp.write(input.path ?? '/fixture/out.txt', input.contents ?? '');
      return Response.json({ ok: true, written: true });
    }
    return Response.json({ error: 'unknown_mode' }, { status: 400 });
  } catch (error) {
    return Response.json({ ok: false, hostKeyChecked, error: error instanceof Error ? error.name : 'unknown' }, { status: 502 });
  } finally {
    try { await sftp?.close(); } catch { /* closing an interrupted channel is best-effort */ }
    try { await client?.close({ timeout: 1000 }); } catch { /* close remains best-effort after a transport failure */ }
  }
}

export class G0SessionDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private session?: { client: SshClient; channel: SshChannel; output: string; closed: boolean };

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const input = await request.json<ProbeRequest>();
    try {
      if (input.mode === 'sessionStart') {
        if (this.session && !this.session.closed) return Response.json({ error: 'session_already_open' }, { status: 409 });
        const { client } = await openClient(input);
        const channel = await client.shell({ pty: { term: 'xterm-256color', columns: 80, rows: 24 } });
        const session = { client, channel, output: '', closed: false };
        this.session = session;
        void channel.exit.then(() => { session.closed = true; }).catch(() => { session.closed = true; });
        const readOutput = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              session.output += new TextDecoder().decode(value);
            }
          } catch {
            session.closed = true;
          } finally { reader.releaseLock(); }
        };
        void readOutput(channel.stdout);
        return Response.json({ ok: true, sessionId: 'g0-live-session', ptyRequested: true });
      }
      if (!this.session || input.sessionId !== 'g0-live-session') return Response.json({ error: 'session_missing' }, { status: 404 });
      if (input.mode === 'sessionWrite') {
        await this.session.channel.write(input.input ?? '');
        return Response.json({ ok: true, writeAccepted: true });
      }
      if (input.mode === 'sessionOutput') return Response.json({ ok: true, output: this.session.output, closed: this.session.closed });
      if (input.mode === 'sessionClose') {
        try { await this.session.channel.close(); } finally {
          this.session.closed = true;
          await this.session.client.close({ timeout: 1000 });
        }
        return Response.json({ ok: true, closed: this.session.closed });
      }
      return Response.json({ error: 'unknown_mode' }, { status: 400 });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.name : 'unknown' }, { status: 502 });
    }
  }
}
