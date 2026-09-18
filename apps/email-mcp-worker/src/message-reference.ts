import { z } from "zod";
import { EmailToolError } from "./errors.js";

export interface MessageReference {
  accountId: string;
  folderId: string;
  uidValidity: string;
  uid: number;
}

export interface SearchCursorScope {
  accountId: string;
  folderId: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
}

const messageReferenceSchema = z.object({
  v: z.literal(1),
  a: z.string().min(1),
  f: z.string().min(1),
  uv: z.string().regex(/^\d+$/),
  uid: z.number().int().positive(),
});

const searchCursorSchema = z.object({
  v: z.literal(1),
  a: z.string().min(1),
  f: z.string().min(1),
  q: z.string(),
  last: z.number().int().positive(),
});

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function canonicalScope(scope: SearchCursorScope): string {
  return JSON.stringify({
    accountId: scope.accountId,
    folderId: scope.folderId,
    from: scope.from ?? null,
    to: scope.to ?? null,
    subject: scope.subject ?? null,
    text: scope.text ?? null,
    after: scope.after ?? null,
    before: scope.before ?? null,
    unread: scope.unread ?? null,
    flagged: scope.flagged ?? null,
  });
}

export function encodeMessageReference(reference: MessageReference): string {
  return base64UrlEncode(
    JSON.stringify({
      v: 1,
      a: reference.accountId,
      f: reference.folderId,
      uv: reference.uidValidity,
      uid: reference.uid,
    }),
  );
}

export function decodeMessageReference(value: string): MessageReference {
  try {
    const parsed = messageReferenceSchema.parse(
      JSON.parse(base64UrlDecode(value)),
    );
    return {
      accountId: parsed.a,
      folderId: parsed.f,
      uidValidity: parsed.uv,
      uid: parsed.uid,
    };
  } catch {
    throw new EmailToolError(
      "MESSAGE_REFERENCE_STALE",
      "The message reference is invalid or stale.",
    );
  }
}

export function encodeSearchCursor(
  scope: SearchCursorScope,
  lastUid: number,
): string {
  return base64UrlEncode(
    JSON.stringify({
      v: 1,
      a: scope.accountId,
      f: scope.folderId,
      q: canonicalScope(scope),
      last: lastUid,
    }),
  );
}

export function decodeSearchCursor(
  cursor: string,
  scope: SearchCursorScope,
): { lastUid: number } {
  try {
    const parsed = searchCursorSchema.parse(
      JSON.parse(base64UrlDecode(cursor)),
    );
    if (
      parsed.a !== scope.accountId ||
      parsed.f !== scope.folderId ||
      parsed.q !== canonicalScope(scope)
    ) {
      throw new Error("cursor scope mismatch");
    }
    return { lastUid: parsed.last };
  } catch {
    throw new EmailToolError(
      "CURSOR_INVALID",
      "The search cursor is invalid for this query.",
    );
  }
}
