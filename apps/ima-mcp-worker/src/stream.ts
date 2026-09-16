export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("Response body exceeded maximum allowed size");
        throw new Error(`远程响应内容超出大小限制 (最大 ${(maxBytes / (1024 * 1024)).toFixed(1)} MB)`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedBuffer(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("Response body exceeded maximum allowed size");
        throw new Error(`远程响应内容超出大小限制 (最大 ${(maxBytes / (1024 * 1024)).toFixed(1)} MB)`);
      }
      chunks.push(value);
    }
    const result = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function readBinaryChunk(
  response: Response,
  skipBytes: number,
  maxBytes: number
): Promise<{ bytes: Uint8Array; hasMore: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), hasMore: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let skipped = 0;
  let received = 0;
  let hasMore = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      if (skipped < skipBytes) {
        const count = Math.min(value.byteLength, skipBytes - skipped);
        skipped += count;
        start = count;
      }
      if (start === value.byteLength) continue;

      const remaining = maxBytes - received;
      if (remaining === 0) {
        hasMore = true;
        await reader.cancel("Binary chunk complete");
        break;
      }
      const take = Math.min(remaining, value.byteLength - start);
      chunks.push(value.slice(start, start + take));
      received += take;
      if (start + take < value.byteLength) {
        hasMore = true;
        await reader.cancel("Binary chunk complete");
        break;
      }
    }

    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: result, hasMore };
  } finally {
    reader.releaseLock();
  }
}

export function bufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
