import { describe, expect, it, vi } from 'vitest';
import { validatePublicEndpoint } from '../../src/registry/endpoint.js';

function resolver(address: string): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => Response.json({
    Status: 0,
    Answer: String(url).includes('type=AAAA') ? [] : [{ type: 1, data: address }]
  })) as unknown as typeof fetch;
}
describe('eligible public database endpoints', () => {
  it('accepts eligible DNS names only when public resolver answers are present', async () => {
    await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one', resolver('1.1.1.1')))
      .resolves.toMatchObject({ dialect: 'postgres', host: 'db.example.org' });
  });
  it('rejects local names, local IPs, TLS downgrade arguments and private resolved addresses', async () => {
    for (const url of [
      'postgres://user@localhost/app', 'postgres://user@127.0.0.1/app',
      'mysql://user@db.local/app', 'mysql://user@db.example.org/app?sslmode=disable'
    ]) await expect(validatePublicEndpoint(url, 'one', resolver('1.1.1.1'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const address of ['127.0.0.1', '10.20.30.40', '169.254.12.1', '192.168.1.1', '100.64.1.1']) {
      await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one', resolver(address)))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
  it('fails closed when public DNS validation fails', async () => {
    await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one',
      vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch))
      .rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
  });
});
