const enc = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...data].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha1Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", enc.encode(value)));
}

export async function hmacSha1Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)));
}
