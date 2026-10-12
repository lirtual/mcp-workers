export type PortalAuthFailureReason =
  | "misconfigured"
  | "unauthorized"
  | "invalid_origin";

export type PortalAuthResult =
  | { ok: true; request: Request }
  | { ok: false; reason: PortalAuthFailureReason };

export interface PortalAuthOptions {
  expectedToken?: string;
  allowedOrigins?: readonly string[];
}

const encoder = new TextEncoder();

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  const left = new Uint8Array(presentedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }

  // Hashing normalizes input lengths and the loop avoids early exit. This is
  // intentionally not named or documented as a proven constant-time primitive.
  return difference === 0;
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function originAllowed(request: Request, allowedOrigins: readonly string[]): boolean {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return true;

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedRequestOrigin) return false;

  return allowedOrigins.some((allowed) => {
    const normalizedAllowed = normalizeOrigin(allowed);
    return normalizedAllowed !== null && normalizedAllowed === normalizedRequestOrigin;
  });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer[\t ]+(.+)$/i);
  return match?.[1] ?? null;
}

export async function authenticatePortalRequest(
  request: Request,
  options: PortalAuthOptions,
): Promise<PortalAuthResult> {
  const expectedToken = options.expectedToken;
  if (!expectedToken) return { ok: false, reason: "misconfigured" };

  if (!originAllowed(request, options.allowedOrigins ?? [])) {
    return { ok: false, reason: "invalid_origin" };
  }

  const presentedToken = bearerToken(request);
  if (!presentedToken || !(await tokenMatches(presentedToken, expectedToken))) {
    return { ok: false, reason: "unauthorized" };
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return {
    ok: true,
    request: new Request(request, { headers }),
  };
}
