import assert from 'node:assert/strict';
import test from 'node:test';
import { isIpLiteral, isPublicAddress, normalizeDnsName } from '../src/target-security.ts';
import { validExecInput } from '../src/validation.ts';

test('public target screening rejects special IPv4 and IPv6 ranges and accepts global unicast', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.1.1', '192.0.2.1', '192.168.1.1', '192.31.196.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8',
    '2001:db8::1', '2001:0:0:1::1', '2001::1', '2001:0:0:0:0:0:0:1',
    '2001:2::1', '2001:0002:0000:0000:0000:0000:0000:0001',
    '2001:2:0:ffff:ffff:ffff:ffff:ffff', '2001:3::1', '2001:1ff::1',
    '2002::1', '2001:20::1', '3fff::1', '3fff:0000:0000:0000:0000:0000:0000:0001',
    '3fff:0:0:ffff::1', '3fff:0:1::1', '3fff:0:fff::1',
    '2606:4700:4700::1111%eth0',
  ]) assert.equal(isPublicAddress(address), false, `${address} must be rejected`);
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:200::1', '2001:4860:4860::8888', '2606:4700:4700::1111', '3fff:1000::1']) {
    assert.equal(isPublicAddress(address), true, `${address} should be accepted`);
  }
  assert.equal(isIpLiteral('fixture.example.test'), false);
  assert.equal(isIpLiteral('2001:4860:4860::8888'), true);
  assert.equal(normalizeDnsName('例え.テスト'), 'xn--r8jz45g.xn--zckzah');
  assert.equal(normalizeDnsName('saved.example:2222'), null);
  assert.equal(normalizeDnsName('user@evil.example'), null);
});

test('exec validation counts UTF-8 bytes and constrains timeout before any DO admission', () => {
  const host = '11111111-1111-4111-8111-111111111111';
  const operation = '22222222-2222-4222-8222-222222222222';
  assert.equal(validExecInput(host, operation, 'x'.repeat(16 * 1024), 30_000), null);
  assert.equal(validExecInput(host, operation, '😀'.repeat(4097), 30_000), 'invalid_args');
  assert.equal(validExecInput(host, operation, 'x', 999), 'invalid_args');
  assert.equal(validExecInput(host, operation, 'x', 60_001), 'invalid_args');
});
