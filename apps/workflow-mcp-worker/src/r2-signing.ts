import type { Env } from './types.js';

export interface R2PresignOptions {
  method: 'GET' | 'PUT';
  key: string;
  expiresInSeconds?: number;
  headers?: Readonly<Record<string, string>>;
  now?: Date;
}

export async function presignR2Url(
  env: Env,
  options: R2PresignOptions
): Promise<string> {
  const accountId = required(env.R2_ACCOUNT_ID, 'R2_ACCOUNT_ID');
  const bucket = required(env.R2_BUCKET_NAME, 'R2_BUCKET_NAME');
  const accessKeyId = required(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID');
  const secretAccessKey = required(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY');
  const expires = options.expiresInSeconds ?? 300;
  if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) {
    throw new Error('R2 presigned URL expiry must be between 1 and 604800 seconds.');
  }

  const now = options.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePath(bucket)}/${encodePath(options.key)}`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const headerEntries = [
    ['host', host] as const,
    ...Object.entries(options.headers ?? {}).map(
      ([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const
    )
  ].sort(([left], [right]) => left.localeCompare(right));

  const canonicalHeaders = headerEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');
  const signedHeaders = headerEntries.map(([name]) => name).join(';');

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', signedHeaders]
  ];
  const canonicalQuery = canonicalQueryString(query);

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const dateKey = await hmac(
    toArrayBuffer(new TextEncoder().encode(`AWS4${secretAccessKey}`)),
    dateStamp
  );
  const regionKey = await hmac(dateKey, 'auto');
  const serviceKey = await hmac(regionKey, 's3');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function canonicalQueryString(entries: readonly [string, string][]): string {
  return entries
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) => {
      const key = keyA.localeCompare(keyB);
      return key !== 0 ? key : valueA.localeCompare(valueB);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map(segment => awsEncode(segment))
    .join('/');
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function formatAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function hmac(key: ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(value))
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}
