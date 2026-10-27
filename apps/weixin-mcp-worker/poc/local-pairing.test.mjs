import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Local HTTP state-machine checks. Never ask upstream for a QR, send, or token.
test('localhost PoC refuses pre-verification sends, cross-site and malformed requests', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./local-pairing.mjs', import.meta.url))], {
    env: { ...process.env, SPEC346_POC_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [data] = await once(child.stdout, 'data');
  const out = data.toString();
  const match = out.match(/SPEC346_LOCAL_POC_READY http:\/\/localhost:(\d+)/);
  assert.ok(match, 'must bind loopback only and report random local test port');
  const base = `http://127.0.0.1:${match[1]}`;
  const origin = `http://localhost:${match[1]}`;
  const get = await fetch(base + '/');
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(get.headers.get('x-frame-options'), 'DENY');
  assert.match(get.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const body = await get.text();
  assert.match(body, /state: unbound/);
  assert.doesNotMatch(body, /<svg/);
  const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.match(csrf, /^[0-9a-f]{48}$/);
  const form = new URLSearchParams({csrf}).toString();
  const options = {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin},body:form};
  for (const endpoint of ['/send','/scan','/verify']) {
    assert.equal((await fetch(base + endpoint, options)).status, 409, endpoint + ' must not dispatch');
  }
  assert.equal((await fetch(base + '/start', {method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://evil.example'},body:form})).status, 403);
  assert.equal((await fetch(base + '/start', {method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',origin},body:'csrf=invalid'})).status, 403);
  assert.equal((await fetch(base + '/send', {method:'POST',body:form})).status, 403);
  const fakeHost = await new Promise((resolve,reject) => {
    const req = httpRequest(base + '/', {headers:{Host:'attacker.invalid'}}, res => {
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });req.on('error',reject);req.end();
  });
  assert.equal(fakeHost, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});
