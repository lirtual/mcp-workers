import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newEnrollment } from "../../remote-control-agent/src/v2-enrollment.ts";
import { openAuthenticatedDeviceSocket } from "../../remote-control-agent/src/v2-session-client.ts";

class FakeSocket extends EventTarget {
  protocol: string;
  readyState: number = WebSocket.CONNECTING;
  closeCount = 0;
  constructor(protocol: string, event: "open" | "error" | "close") {
    super();
    this.protocol = protocol;
    queueMicrotask(() => {
      if (event === "open") this.readyState = WebSocket.OPEN;
      if (event === "close") this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event(event));
    });
  }
  close() { this.closeCount++; this.readyState = WebSocket.CLOSED; }
}

async function harness(
  selectedProtocol: string, event: "open" | "error" | "close" = "open",
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-session-protocol-"));
  const file = path.join(dir, "identity.pem");
  const enrollment = newEnrollment("host");
  const id = randomUUID();
  await writeFile(file, enrollment.privateKeyPem, { mode: 0o600 });
  await writeFile(file + ".device-id", id + "\n", { mode: 0o600 });
  const nonce = "A".repeat(24);
  const calls: Array<{ url: string; protocols: string[] }> = [];
  let socket: FakeSocket | undefined;
  const send: typeof fetch = async () =>
    Response.json({ device_id: id, nonce, expires_at: Date.now() + 30_000 });
  const makeSocket = (url: string, protocols: string[]): WebSocket => {
    calls.push({ url, protocols });
    socket = new FakeSocket(selectedProtocol, event);
    return socket as unknown as WebSocket;
  };
  return {
    file, id, calls, send, makeSocket,
    socket: () => socket!,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("v2 client accepts only the negotiated safe protocol marker, never a proof or another protocol", async () => {
  const good = await harness("rc-v2");
  try {
    const result = await openAuthenticatedDeviceSocket("https://trusted.example/", good.file, good.send, good.makeSocket);
    assert.equal(result.device_id, good.id);
    assert.equal(good.calls.length, 1);
    assert.match(good.calls[0]!.url, /^wss:\/\/trusted\.example\/agent\/connect\//);
    assert.equal(good.calls[0]!.protocols[0], "rc-v2");
    assert.match(good.calls[0]!.protocols[1]!, /^rcv2\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{86}$/);
    assert.equal(good.socket().closeCount, 0);
  } finally { await good.close(); }

  for (const invalid of ["", "rcv2." + "A".repeat(24) + "." + "B".repeat(86), "rc-v3"]) {
    const fixture = await harness(invalid);
    try {
      await assert.rejects(
        openAuthenticatedDeviceSocket("https://trusted.example/", fixture.file, fixture.send, fixture.makeSocket),
        /unexpected protocol/,
      );
      assert.equal(fixture.socket().closeCount, 1, "invalid subprotocol must be closed");
    } finally { await fixture.close(); }
  }
});

test("v2 client aborts failed or rejected handshake and closes unauthenticated socket", async () => {
  for (const event of ["error", "close"] as const) {
    const fixture = await harness("rc-v2", event);
    try {
      await assert.rejects(
        openAuthenticatedDeviceSocket("http://127.0.0.1:18769/", fixture.file, fixture.send, fixture.makeSocket),
        /authentication/,
      );
      assert.equal(fixture.socket().closeCount, 1);
    } finally { await fixture.close(); }
  }
});
