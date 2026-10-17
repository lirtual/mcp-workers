import { connect, SshHostKeyError } from '@meitaim/ssh';

interface ProbeRequest {
  mode: 'password' | 'privateKey' | 'disconnect';
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  expectedFingerprint: string;
  command: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let input: ProbeRequest;
    try {
      input = await request.json<ProbeRequest>();
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    let hostKeyChecked = false;
    try {
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
          return key.fingerprint === input.expectedFingerprint;
        },
      });
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
