/** Device-key-authenticated WSS, deliberately without remote operation handlers. */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const SESSION_DOMAIN = "remote-control:v2:session:";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function endpoint(baseAddress: string): URL {
  const value = new URL(baseAddress);
  const local = value.protocol === "http:" && value.hostname === "127.0.0.1" && !!value.port;
  if ((!local && value.protocol !== "https:") || value.username || value.password ||
      value.search || value.hash || value.pathname !== "/") {
    throw new Error("A trusted HTTPS endpoint (or IPv4 loopback test endpoint) is required.");
  }
  return value;
}

function encode64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function signedSessionProof(pem: string, deviceId: string, nonce: string): {
  proof: string; public_key: string;
} {
  if (!UUID.test(deviceId) || !/^[A-Za-z0-9_-]{24}$/.test(nonce)) {
    throw new Error("Invalid device session challenge.");
  }
  const privateKey = createPrivateKey(pem);
  const public_key = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" })).toString("base64");
  const body = Buffer.from(SESSION_DOMAIN + deviceId + ":" + nonce + ":" + public_key);
  return { proof: encode64url(Buffer.from(sign(null, body, privateKey))), public_key };
}

async function postJson(base: URL, path: string, body: object, send: typeof fetch): Promise<{ status: number; result: any }> {
  const response = await send(new URL(path, base), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) return { status: response.status, result: {} };
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid server response.");
  return { status: response.status, result };
}

export async function recoverDeviceId(
  baseAddress: string, keyPath: string, send: typeof fetch = fetch,
): Promise<string> {
  const base = endpoint(baseAddress);
  const privatePem = await readFile(keyPath, "utf8");
  const publicKey = Buffer.from(createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" })).toString("base64");
  const challenged = await postJson(base, "/agent/session/challenge", { public_key: publicKey }, send);
  if (challenged.status !== 200 || !UUID.test(challenged.result.device_id) ||
      !/^[A-Za-z0-9_-]{24}$/.test(challenged.result.nonce)) {
    throw new Error("No approved device identity matches this key.");
  }
  const { proof } = signedSessionProof(privatePem, challenged.result.device_id, challenged.result.nonce);
  const result = await postJson(base, "/agent/session/recover", {
    device_id: challenged.result.device_id, nonce: challenged.result.nonce, proof,
  }, send);
  if (result.status !== 200 || result.result.status !== "verified" ||
      result.result.device_id !== challenged.result.device_id) {
    throw new Error("Signed device identity recovery failed.");
  }
  // This is an identity recovery, NOT a replay of an uncertain Shell mutation.
  // A lost recovery response may be handled by a fresh nonce/challenge.
  try {
    await writeFile(keyPath + ".device-id", result.result.device_id + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const existing = (await readFile(keyPath + ".device-id", "utf8")).trim();
    if (existing !== result.result.device_id) throw new Error("Device ID on disk does not match authenticated identity.");
  }
  return result.result.device_id;
}

export async function openAuthenticatedDeviceSocket(
  baseAddress: string, keyPath: string, send: typeof fetch = fetch,
  makeSocket: (url: string, protocols: string[]) => WebSocket = (url, protocols) => new WebSocket(url, protocols),
): Promise<{ device_id: string; socket: WebSocket }> {
  const base = endpoint(baseAddress);
  const privatePem = await readFile(keyPath, "utf8");
  let deviceId: string;
  try { deviceId = (await readFile(keyPath + ".device-id", "utf8")).trim(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    deviceId = await recoverDeviceId(baseAddress, keyPath, send);
  }
  if (!UUID.test(deviceId)) throw new Error("Invalid local device ID.");
  const challenged = await postJson(base, "/agent/session/challenge", { device_id: deviceId }, send);
  if (challenged.status !== 200 || challenged.result.device_id !== deviceId ||
      !/^[A-Za-z0-9_-]{24}$/.test(challenged.result.nonce)) {
    throw new Error("Could not obtain a valid session challenge.");
  }
  const { proof } = signedSessionProof(privatePem, deviceId, challenged.result.nonce);
  const wsUrl = new URL("/agent/connect/" + deviceId, base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const socket = makeSocket(wsUrl.toString(), ["rc-v2", "rcv2." + challenged.result.nonce + "." + proof]);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      try { socket.close(); } catch { /* already closed */ }
      reject(new Error(message));
    };
    const onOpen = () => {
      if (finished) return;
      // WebSocket may negotiate any one of the offered subprotocols. Only the
      // non-credential rc-v2 marker is allowed as the server's selection.
      if (socket.protocol !== "rc-v2" || socket.readyState !== WebSocket.OPEN) {
        fail("WSS returned an unexpected protocol or state.");
        return;
      }
      finished = true;
      cleanup();
      resolve();
    };
    const onError = () => fail("WSS authentication failed.");
    const onClose = () => fail("WSS authentication was rejected.");
    const timeout = setTimeout(() => fail("WSS login timed out."), 10_000);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    // Protect the factory's extremely rare already-open/closed synchronous case.
    if (socket.readyState === WebSocket.OPEN) onOpen();
    else if (socket.readyState === WebSocket.CLOSED) onClose();
  });
  return { device_id: deviceId, socket };
}
