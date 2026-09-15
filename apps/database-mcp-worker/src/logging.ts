import { sanitizedSqlPreview } from './sql/guard.js';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function principalLogId(principal: string): Promise<string> {
  return (await sha256Hex(principal)).slice(0, 20);
}

export async function sqlLogFields(sql: string): Promise<{ sqlHash: string; sqlPreview: string }> {
  return { sqlHash: await sha256Hex(sql), sqlPreview: sanitizedSqlPreview(sql, 500) };
}

export function emitLog(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}
