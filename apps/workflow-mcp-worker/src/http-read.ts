export interface HttpReadResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface HttpReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export async function httpRead(urlText: string, options: HttpReadOptions = {}): Promise<HttpReadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = validatePublicHttpUrl(urlText);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/*, application/json, application/xml;q=0.9, */*;q=0.1' }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('HTTP redirect did not include a Location header.');
      if (redirectCount === maxRedirects) throw new Error('HTTP redirect limit exceeded.');
      current = validatePublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!isTextualContentType(contentType)) {
      throw new Error('HTTP response content type is not supported by http.read.');
    }

    const body = await readBoundedText(response, maxBytes);
    return { url: current.toString(), status: response.status, contentType, body };
  }

  throw new Error('HTTP redirect limit exceeded.');
}

export function validatePublicHttpUrl(urlText: string): URL {
  const url = new URL(urlText);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('http.read accepts only HTTP(S) URLs.');
  }
  if (url.username || url.password) throw new Error('http.read URLs cannot contain credentials.');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('http.read rejects local/private hostnames.');
  }

  if (isBlockedIpLiteral(hostname)) throw new Error('http.read rejects private or reserved IP targets.');
  return url;
}

function isBlockedIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) {
    const lower = hostname.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.') ||
      lower.startsWith('::ffff:169.254.')
    );
  }

  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
  const bytes = parts.map(Number);
  if (bytes.some(byte => byte < 0 || byte > 255)) return true;
  const [a, b] = bytes as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextualContentType(value: string): boolean {
  const normalized = value.split(';', 1)[0]!.trim().toLowerCase();
  if (normalized === '') return true;
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/xml' ||
    normalized.endsWith('+xml') ||
    normalized === 'application/xhtml+xml'
  );
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new Error('HTTP response exceeds the configured byte limit.');

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response too large');
      throw new Error('HTTP response exceeds the configured byte limit.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }

  return text + decoder.decode();
}
