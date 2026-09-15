export type OriginAuthResult =
  | { ok: true; request: Request }
  | { ok: false; reason: "misconfigured" | "unauthorized" };

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

export function authenticateOrigin(request: Request, expectedToken?: string): OriginAuthResult {
  if (!expectedToken) return { ok: false, reason: "misconfigured" };

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return { ok: false, reason: "unauthorized" };

  const presented = authorization.slice(prefix.length);
  if (!presented || !constantTimeEqual(presented, expectedToken)) {
    return { ok: false, reason: "unauthorized" };
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return { ok: true, request: new Request(request, { headers }) };
}
