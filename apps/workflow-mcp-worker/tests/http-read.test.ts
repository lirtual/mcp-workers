import { describe, expect, it, vi } from 'vitest';
import { httpRead, validatePublicHttpUrl } from '../src/http-read.js';

describe('http.read safety', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.1.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://localhost/',
    'http://service.internal/'
  ])('rejects private/local target %s', target => {
    expect(() => validatePublicHttpUrl(target)).toThrow(/rejects/);
  });

  it('rejects non-http schemes and URL credentials', () => {
    expect(() => validatePublicHttpUrl('file:///etc/passwd')).toThrow(/HTTP\(S\)/);
    expect(() => validatePublicHttpUrl('https://user:pass@example.com/')).toThrow(/credentials/);
  });

  it('revalidates redirect destinations before following them', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private' }
      })
    );

    await expect(
      httpRead('https://example.com/start', { fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow(/private or reserved/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns bounded text content for a public response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('hello', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    );

    await expect(
      httpRead('https://example.com/data', { fetchImpl: fetchImpl as typeof fetch })
    ).resolves.toEqual({
      url: 'https://example.com/data',
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: 'hello'
    });
  });

  it('rejects oversized response bodies while streaming', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('abcdef', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      })
    );

    await expect(
      httpRead('https://example.com/data', {
        fetchImpl: fetchImpl as typeof fetch,
        maxBytes: 4
      })
    ).rejects.toThrow(/byte limit/);
  });
});
