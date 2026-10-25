import nodemailer from 'nodemailer';
import { resolvePublicMailEndpoint } from './mail-endpoints.ts';
import { protocolCredentials } from './imap.ts';
import type { ProtocolCredentials } from './imap.ts';
import { fail, MailError } from './types.ts';
import type { Env, MailAccount } from './types.ts';
import type { AttachmentFile } from './attachments.ts';

async function createVerifiedTransport(cfg: ProtocolCredentials) {
  const target = await resolvePublicMailEndpoint(cfg.smtp_host);
  return nodemailer.createTransport({
    host: target.address, port: cfg.smtp_port, secure: cfg.smtp_port === 465,
    requireTLS: cfg.smtp_port === 587, ignoreTLS: false,
    auth: { user: cfg.smtp_username ?? cfg.username, pass: cfg.smtp_password ?? cfg.password },
    tls: { servername: target.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    pool: false, logger: false, debug: false, connectionTimeout: 10000,
    greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 5000,
  });
}
export async function verifySmtpCredentials(cfg: ProtocolCredentials): Promise<void> {
  const client = await createVerifiedTransport(cfg);
  try { await client.verify(); }
  catch { fail('smtp_connection_failed'); }
  finally { client.close(); }
}
export async function smtpSend(env: Env, account: MailAccount, to: string[],
  subject: string, body: string, files: AttachmentFile[]) {
  if (account.provider !== 'imap_smtp') fail('unsupported');
  const client = await createVerifiedTransport(await protocolCredentials(env, account));
  try {
    const result = await client.sendMail({
      from: account.address, to, subject, text: body, disableFileAccess: true, disableUrlAccess: true,
      attachments: files.map(f => ({ filename: f.filename, contentType: f.mimeType,
        content: Buffer.from(f.data) })),
    });
    return { status: 'accepted' as const, reference: result.messageId ?? null };
  } catch (err) {
    if (err instanceof MailError) throw err;
    // Submission might have reached the provider. The outer D1 fence records unknown outcome.
    return fail('smtp_indeterminate');
  } finally { client.close(); }
}
