import test from 'node:test';
import assert from 'node:assert/strict';
import { publicIp, validateMailHost, validateMailPorts, assertPublicMailEndpoint } from '../src/mail-endpoints.ts';
test('IMAP/SMTP endpoint policy rejects localhost, private/reserved IPs and port 25', () => {
  for (const hostname of ['localhost','mail.local','127.0.0.1','mail.internal','example.test','https://smtp.example.com','mail..com']) {
    assert.throws(() => validateMailHost(hostname), /invalid_mail_host/);
  }
  assert.equal(validateMailHost('SMTP.QQ.COM'), 'smtp.qq.com');
  assert.doesNotThrow(() => validateMailPorts(993, 465));
  assert.doesNotThrow(() => validateMailPorts(993, 587));
  assert.throws(() => validateMailPorts(143, 465), /unsupported_mail_port/);
  assert.throws(() => validateMailPorts(993, 25), /unsupported_mail_port/);
  for (const ip of ['0.0.0.0', '10.0.0.1','127.0.0.1','172.16.0.2','192.168.1.1',
    '100.64.1.1','169.254.169.254','198.18.1.1','198.51.100.2','192.0.2.4',
    '203.0.113.2', '224.0.0.1','::1','fc00::1','fe80::2','2001:db8::1']) {
    assert.equal(publicIp(ip), false, ip);
  }
  for (const ip of ['8.8.8.8','1.1.1.1','192.12.1.2','2001:4860:4860::8888']) {
    assert.equal(publicIp(ip), true, ip);
  }
});
test('DNS policy requires only public addresses and fails closed on DNS failure/rebinding', async () => {
  const requests: string[] = [];
  const pub = (async (uri: string) => {
    requests.push(uri);
    const type = new URL(uri).searchParams.get('type');
    return Response.json({ Status: 0, Answer: type === '1' ? [{type:1, data:'1.1.1.1'}] : [] });
  }) as typeof fetch;
  assert.equal(await assertPublicMailEndpoint('imap.qq.com', pub), 'imap.qq.com');
  assert.equal(requests.length, 2);
  const privateDns = (async (uri: string) =>
    Response.json({ Status: 0, Answer: new URL(uri).searchParams.get('type') === '1' ? [
      { type: 1, data: '10.0.0.8' }] : [] })) as typeof fetch;
  await assert.rejects(() => assertPublicMailEndpoint('imap.qq.com', privateDns), /unsafe_mail_host/);
  const down = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await assert.rejects(() => assertPublicMailEndpoint('imap.qq.com', down), /dns_unavailable/);
});
