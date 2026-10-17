import assert from 'node:assert/strict';
import test from 'node:test';
import { isIpLiteral, isPublicAddress, normalizeDnsName } from '../src/target-security.ts';
import { validExecInput, validSessionInput, validSessionStop, validSftpDeleteInput, validSftpInput, validSftpMkdirInput, validSftpRenameInput, validSftpWriteInput } from '../src/validation.ts';

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

test('session input counts UTF-8 bytes and stop requires only the owned session and operation ids', () => {
  const session = '33333333-3333-4333-8333-333333333333';
  const operation = '44444444-4444-4444-8444-444444444444';
  assert.equal(validSessionInput(session, operation, 'x'.repeat(16 * 1024)), null);
  assert.equal(validSessionInput(session, operation, '😀'.repeat(4097)), 'invalid_args');
  assert.equal(validSessionInput(session, operation, ''), 'invalid_args');
  assert.equal(validSessionInput(session, 'not-a-uuid', 'x'), 'invalid_args');
  assert.equal(validSessionStop(session, operation), null);
  assert.equal(validSessionStop('not-a-session', operation), 'invalid_args');
});

test('SFTP path validation counts UTF-8 bytes and rejects an empty path before a connection', () => {
  const host = '11111111-1111-4111-8111-111111111111';
  assert.equal(validSftpInput(host, `/${'x'.repeat(4095)}`, 30_000), null);
  assert.equal(validSftpInput(host, `/${'x'.repeat(4096)}`, 60_000), 'invalid_args');
  assert.equal(validSftpInput(host, '😀'.repeat(1024), 30_000), null);
  assert.equal(validSftpInput(host, '😀'.repeat(1025), 30_000), 'invalid_args');
  assert.equal(validSftpInput(host, '', 30_000), 'invalid_args');
  assert.equal(validSftpInput(host, '/fixture\0hidden', 30_000), 'invalid_args');
  assert.equal(validSftpInput(host, '/fixture', 999), 'invalid_args');
  assert.equal(validSftpInput(host, '/fixture', 60_001), 'invalid_args');
  assert.equal(validSftpInput('not-a-host', '/fixture', 30_000), 'invalid_args');
});

test('SFTP write validation requires explicit overwrite and rejects over-limit UTF-8 before admission', () => {
  const host = '11111111-1111-4111-8111-111111111111';
  const operation = '22222222-2222-4222-8222-222222222222';
  assert.equal(validSftpWriteInput(host, operation, '/fixture/out.txt', 'héllo', false, 30_000), null);
  assert.equal(validSftpWriteInput(host, operation, '/fixture/out.txt', 'x'.repeat(64 * 1024), true, 60_000), null);
  assert.equal(validSftpWriteInput(host, operation, '/fixture/out.txt', 'x'.repeat(64 * 1024 + 1), true, 30_000), 'invalid_args');
  assert.equal(validSftpWriteInput(host, operation, '/fixture/out.txt', '😀'.repeat(16 * 1024 + 1), false, 30_000), 'invalid_args');
  assert.equal(validSftpWriteInput(host, operation, '/fixture/out.txt', 'x', undefined, 30_000), 'invalid_args');
  assert.equal(validSftpWriteInput(host, operation, '😀'.repeat(1025), 'x', false, 30_000), 'invalid_args');
  assert.equal(validSftpWriteInput(host, 'not-an-operation', '/fixture/out.txt', 'x', false, 30_000), 'invalid_args');
});

test('SFTP rename, delete, and mkdir validation rejects implicit intent and over-limit paths before admission', () => {
  const host = '11111111-1111-4111-8111-111111111111';
  const operation = '22222222-2222-4222-8222-222222222222';
  const longPath = '😀'.repeat(1025);
  assert.equal(validSftpRenameInput(host, operation, '/fixture/a.txt', '/fixture/b.txt', false, 30_000), null);
  assert.equal(validSftpRenameInput(host, operation, '/fixture/a.txt', '/fixture/b.txt', undefined, 30_000), 'invalid_args');
  assert.equal(validSftpRenameInput(host, operation, longPath, '/fixture/b.txt', true, 30_000), 'invalid_args');
  assert.equal(validSftpRenameInput(host, operation, '/fixture/a.txt', longPath, false, 60_000), 'invalid_args');
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'file', true, undefined, 30_000), null);
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'empty_directory', true, undefined, 30_000), null);
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'file', undefined, undefined, 30_000), 'invalid_args');
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'file', false, undefined, 30_000), 'invalid_args');
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'directory', true, undefined, 30_000), 'invalid_args');
  assert.equal(validSftpDeleteInput(host, operation, '/fixture/a.txt', 'file', true, true, 30_000), 'invalid_args');
  assert.equal(validSftpDeleteInput(host, operation, longPath, 'file', true, undefined, 30_000), 'invalid_args');
  assert.equal(validSftpMkdirInput(host, operation, '/fixture/new', 30_000), null);
  assert.equal(validSftpMkdirInput(host, operation, longPath, 30_000), 'invalid_args');
  assert.equal(validSftpMkdirInput(host, 'not-an-operation', '/fixture/new', 30_000), 'invalid_args');
});
