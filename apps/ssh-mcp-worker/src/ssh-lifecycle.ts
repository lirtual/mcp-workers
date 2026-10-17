import type { SshChannel, SshClient } from '@meitaim/ssh';

const CLIENT_CLOSE_TIMEOUT_MS = 1_000;
const CLEANUP_DEADLINE_MS = 1_100;

/** Start channel and transport closure independently; a stalled channel must not prevent transport abort. */
export async function closeSshResources(channel?: SshChannel, client?: SshClient): Promise<void> {
  const channelClose = channel ? Promise.resolve().then(() => channel.close()).catch(() => undefined) : Promise.resolve();
  const clientClose = client
    ? Promise.resolve().then(() => client.close({ timeout: CLIENT_CLOSE_TIMEOUT_MS })).catch(() => undefined)
    : Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, CLEANUP_DEADLINE_MS);
  });
  try {
    await Promise.race([Promise.all([channelClose, clientClose]), clientClose, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
