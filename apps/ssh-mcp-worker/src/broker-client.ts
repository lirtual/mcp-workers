import type { Env } from './types.ts';
import { HostError, type HostView, type SshHostCredentials } from './hosts.ts';

type BrokerError = 'broker_forbidden' | 'host_not_found' | 'host_untrusted' | 'broker_unavailable';
export type BrokerReply<T> = { ok: true; value: T } | { ok: false; error: BrokerError };
export interface HostBroker {
  listHostMetadata(request: { token: string; cursor?: string; limit?: number }):
    Promise<BrokerReply<{ hosts: HostView[]; nextCursor: string | null }>>;
  getHostMetadata(request: { token: string; hostId: string }): Promise<BrokerReply<HostView>>;
  resolveHostForConnection(request: { token: string; hostId: string }): Promise<BrokerReply<SshHostCredentials>>;
}

function token(env: Env): string {
  if (!env.MCP_BROKER_TOKEN || env.MCP_BROKER_TOKEN.length < 32) throw new Error('host_catalog_unavailable');
  return env.MCP_BROKER_TOKEN;
}
function extract<T>(reply: BrokerReply<T>): T {
  if (!reply || typeof reply !== 'object' || reply.ok !== true) {
    const error = reply && 'error' in reply ? reply.error : 'broker_unavailable';
    if (error === 'host_not_found' || error === 'host_untrusted') throw new HostError(error);
    throw new Error('host_catalog_unavailable');
  }
  return reply.value;
}
/**
 * Service binding is opt-in. Never silently fall back to the D1 + root
 * encryption key when an explicitly configured broker rejects a request.
 */
export async function brokerListHosts(env: Env, input: { cursor?: string; limit?: number }):
  Promise<{ hosts: HostView[]; nextCursor: string | null }> {
  const remote = env.EDGE_SSH_BROKER;
  if (!remote) throw new Error('host_catalog_unavailable');
  try {
    const reply = await remote.listHostMetadata({ token: token(env), ...input });
    const value = extract(reply);
    if (!value || !Array.isArray(value.hosts) || value.hosts.length > 50
      || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('host_catalog_unavailable');
    return value;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new Error('host_catalog_unavailable');
  }
}
export async function brokerGetHost(env: Env, hostId: string): Promise<HostView> {
  const remote = env.EDGE_SSH_BROKER;
  if (!remote) throw new Error('host_catalog_unavailable');
  try {
    const value = extract(await remote.getHostMetadata({ token: token(env), hostId }));
    if (!value || value.id.toLowerCase() !== hostId.toLowerCase()) throw new Error('host_catalog_unavailable');
    return value;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new Error('host_catalog_unavailable');
  }
}
export async function brokerResolveHost(env: Env, hostId: string): Promise<SshHostCredentials> {
  const remote = env.EDGE_SSH_BROKER;
  if (!remote) throw new Error('host_catalog_unavailable');
  try {
    const value = extract(await remote.resolveHostForConnection({ token: token(env), hostId }));
    if (!value || value.id.toLowerCase() !== hostId.toLowerCase()
      || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint)) throw new Error('host_catalog_unavailable');
    return value;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new Error('host_catalog_unavailable');
  }
}
