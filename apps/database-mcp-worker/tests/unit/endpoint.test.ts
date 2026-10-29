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
  it('accepts globally routable literal IPs for MySQL Direct without a DNS lookup', async () => {
    const noDns = vi.fn(async (): Promise<Response> => { throw new Error('DNS lookup not expected'); }) as unknown as typeof fetch;
    await expect(validatePublicEndpoint('mysql://reader:password@93.184.216.34:3306/app', 'one', noDns))
      .resolves.toMatchObject({ dialect: 'mysql', host: '93.184.216.34', port: 3306 });
    await expect(validatePublicEndpoint('mysql://reader:password@[2606:4700::1111]:3306/app', 'one', noDns))
      .resolves.toMatchObject({ dialect: 'mysql' });
    expect(noDns).not.toHaveBeenCalled();
  });
  it('rejects private, special-use, mapped, and loopback literal IPs for MySQL Direct', async () => {
    const invalidHosts = ['0.0.0.0', '10.2.3.4', '100.64.1.1', '127.0.0.1', '169.254.169.254',
      '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
      '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '[::1]', '[::ffff:127.0.0.1]', '[fe80::1]', '[2001:db8::1]'];
    for (const host of invalidHosts) {
      await expect(validatePublicEndpoint(`mysql://reader:password@${host}:3306/app`, 'one'))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
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
  it('normalizes IPv6 DNS answers before checking reserved and documentation networks', async () => {
    const resolver6 = (address: string): typeof fetch =>
      vi.fn(async (url: RequestInfo | URL) => Response.json({
        Status: 0,
        Answer: String(url).includes('type=AAAA')
          ? [{ type: 28, data: address }]
          : [{ type: 1, data: '1.1.1.1' }]
      })) as unknown as typeof fetch;
    for (const address of [
      '2001:0db8::1', '2001:0000::1', '2001:0010::1', '2001:0020::1',
      '2001:2::1', '2001:0002:0:1234::1', // benchmarking /48
      '2001:11::1', '2001:2f::1', // ORCHID /28 ranges
      '3fff::1', '3fff:0fff::1', // IANA documentation /20
      '2002::1' // 6to4 special-purpose prefix
    ]) {
      await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one', resolver6(address)))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one',
      resolver6('2606:4700::1111'))).resolves.toMatchObject({ host: 'db.example.org' });
  });
  it('fails closed when public DNS validation fails', async () => {
    await expect(validatePublicEndpoint('postgres://user@db.example.org/app', 'one',
      vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch))
      .rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
  });
});
