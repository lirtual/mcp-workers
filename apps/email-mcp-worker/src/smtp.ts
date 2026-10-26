import nodemailer from 'nodemailer';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { resolvePublicMailEndpoint } from './mail-endpoints.ts';
import { protocolCredentials } from './imap.ts';
import type { ProtocolCredentials } from './imap.ts';
import { fail, MailError } from './types.ts';
import type { Env, MailAccount } from './types.ts';
import type { AttachmentFile } from './attachments.ts';

async function createVerifiedTransport(cfg: ProtocolCredentials) {
  const target = await resolvePublicMailEndpoint(cfg.smtp_host);
  return nodemailer.createTransport({
    host: target.hostname, port: cfg.smtp_port, secure: cfg.smtp_port === 465,
    requireTLS: cfg.smtp_port === 587, ignoreTLS: false,
    auth: { user: cfg.smtp_username ?? cfg.username, pass: cfg.smtp_password ?? cfg.password },
    tls: { servername: target.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    pool: false, logger: false, debug: false, connectionTimeout: 10000,
    greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 5000,
    // Nodemailer's own DNS lookup yields a numeric-IP TCP destination that
    // Workers rejects. Preconnect by validated hostname, then hand the socket
    // to Nodemailer. This is NOT a DNS-to-connected-IP pinning guarantee.
    getSocket(_options, callback) {
      const implicitTls = cfg.smtp_port === 465;
      const socket = implicitTls
        ? tlsConnect({ host: target.hostname, port: 465, servername: target.hostname,
            rejectUnauthorized: true, minVersion: 'TLSv1.2', timeout: 10000 })
        : tcpConnect({ host: target.hostname, port: 587, timeout: 10000 });
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (error) {
          socket.destroy();
          callback(error);
        } else {
          socket.setTimeout(0);
          callback(null, { connection: socket, secured: implicitTls });
        }
      };
      socket.once(implicitTls ? 'secureConnect' : 'connect', () => {
        if (implicitTls && 'authorized' in socket && !socket.authorized)
          return finish(new Error('SMTP TLS certificate validation failed'));
        finish();
      });
      socket.once('error', (error) => finish(error));
      socket.once('timeout', () => finish(new Error('SMTP connection timeout')));
    },
  });
}
export async function verifySmtpCredentials(cfg: ProtocolCredentials): Promise<void> {
  const client = await createVerifiedTransport(cfg);
  try { await client.verify(); }
  catch { fail('smtp_connection_failed'); }
  finally { client.close(); }
}
/**
 * Nodemailer resolves sendMail when even one RCPT TO succeeds. Treat partial
 * acceptance as an uncertain operation, never a fully accepted send; the D1
 * request fence prevents replay to recipients who may already have received it.
 */
export function assertSmtpRecipientAcceptance(
  result: { accepted?: string[]; rejected?: string[] }, requested: string[],
): void {
  if (!Array.isArray(result.accepted) || !Array.isArray(result.rejected) ||
    result.rejected.length > 0 ||
    requested.some(to => !result.accepted!.some(accepted => accepted.toLowerCase() === to.toLowerCase())))
    fail('smtp_partial_rejection');
}
export async function smtpSend(env: Env, account: MailAccount, to: string[],
  subject: string, body: string, files: AttachmentFile[],
  relation?: { inReplyTo: string; references: string }) {
  if (account.provider !== 'imap_smtp') fail('unsupported');
  const client = await createVerifiedTransport(await protocolCredentials(env, account));
  try {
    const result = await client.sendMail({
      from: account.address, to, subject, text: body,
      inReplyTo: relation?.inReplyTo, references: relation?.references, disableFileAccess: true, disableUrlAccess: true,
      attachments: files.map(f => ({ filename: f.filename, contentType: f.mimeType,
        content: Buffer.from(f.data) })),
    });
    assertSmtpRecipientAcceptance(result, to);
    return { status: 'accepted' as const, reference: result.messageId ?? null };
  } catch (err) {
    if (err instanceof MailError) throw err;
    // Submission might have reached the provider. The outer D1 fence records unknown outcome.
    return fail('smtp_indeterminate');
  } finally { client.close(); }
}
