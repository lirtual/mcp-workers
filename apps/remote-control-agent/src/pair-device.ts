/**
 * Explicit v2 *pending-only* Agent enrolment. This does not authorize remote
 * calls, create a command connection, or install a running background service.
 */
import { mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newEnrollment, saveNewPrivateKey } from "./v2-enrollment.ts";

const DEFAULT_KEY_FILE = path.join(
  os.homedir(), ".local", "share", "mcp-workers", "remote-control", "v2-identity.pem",
);

export interface PendingEnrollmentResult {
  code: string;
  expiresAt: number;
  keyPath: string;
}

export async function beginDeviceEnrollment(
  name: string,
  endpoint: string,
  keyPath = DEFAULT_KEY_FILE,
  send: typeof fetch = fetch,
): Promise<PendingEnrollmentResult> {
  const base = new URL(endpoint);
  const local = base.protocol === "http:" && base.hostname === "127.0.0.1";
  if ((!local && base.protocol !== "https:") || base.username || base.password ||
      base.search || base.hash || base.pathname !== "/" || (local && !base.port)) {
    throw new Error("Enrollment requires a trusted HTTPS endpoint (or local test endpoint).");
  }

  const material = newEnrollment(name);
  await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  await saveNewPrivateKey(keyPath, material.privateKeyPem);
  try {
    const result = await send(new URL("/agent/pair/start", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(material.request),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (result.status !== 202) {
      throw new Error("Pending enrollment was not accepted.");
    }
    return { code: material.code, expiresAt: material.request.issued_at + 600_000, keyPath };
  } catch {
    // A request may have arrived despite a lost response; any orphaned pending
    // record expires. Do not retain a local key that has not been acknowledged.
    await unlink(keyPath).catch(() => {});
    throw new Error("Pending enrollment could not be completed.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const endpoint = process.env.REMOTE_CONTROL_V2_ENDPOINT;
  if (!endpoint) {
    process.stderr.write("REMOTE_CONTROL_V2_ENDPOINT must be configured.\n");
    process.exitCode = 1;
  } else {
    try {
      const device = await beginDeviceEnrollment(process.argv[2] || os.hostname(), endpoint);
      process.stdout.write(
        `Pending device. Pairing code: ${device.code}\nExpires after 10 minutes. Review this device in your authenticated Remote Control MCP.\n`,
      );
    } catch {
      process.stderr.write("Pending device enrollment failed. Check the endpoint and local key path.\n");
      process.exitCode = 1;
    }
  }
}
