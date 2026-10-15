import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newEnrollment } from "../src/v2-enrollment.ts";
import { maintainAuthenticatedDeviceSession, monitorDeviceSocket } from "../src/v2-connection-lifecycle.ts";

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  protocol = "rc-v2";
  sent: string[] = [];
  closeCount = 0;
  onSend?: (text: string) => void;
  send(text: string) {
    this.sent.push(text);
    this.onSend?.(text);
  }
  close() {
    this.closeCount++;
    this.readyState = WebSocket.CLOSED;
  }
  event(type: string, props: Record<string, unknown> = {}) {
    const event = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(event, k, { value: v });
    this.dispatchEvent(event);
  }
  emitOpen() { this.readyState = WebSocket.OPEN; this.event("open"); }
  emitClose(code: number, reason = "") { this.readyState = WebSocket.CLOSED; this.event("close", { code, reason }); }
  pong() { this.event("message", { data: "rc-v2:pong" }); }
}

const timings = { intervalMs: 15, timeoutMs: 9 };

test("hibernation-safe heartbeat accepts automatic pong without requiring DO application messages", async () => {
  const socket = new FakeSocket();
  const abort = new AbortController();
  socket.onSend = () => queueMicrotask(() => socket.pong());
  const pending = monitorDeviceSocket(socket as unknown as WebSocket, abort.signal, timings);
  await new Promise(resolve => setTimeout(resolve, 85));
  assert.ok(socket.sent.length >= 2, "connection should have been probed more than once");
  assert.ok(socket.sent.every(x => x === "rc-v2:ping"));
  assert.equal(socket.closeCount, 0);
  abort.abort();
  assert.equal(await pending, "aborted");
  assert.equal(socket.closeCount, 1);
});

test("missing pong detects half-open connection and closes it", async () => {
  const socket = new FakeSocket();
  const outcome = await monitorDeviceSocket(socket as unknown as WebSocket, new AbortController().signal, timings);
  assert.equal(outcome, "offline");
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.closeCount, 1);
});

test("policy closure and unexpected server messages stop the monitor without replaying operations", async () => {
  const policy = new FakeSocket();
  const pending = monitorDeviceSocket(policy as unknown as WebSocket, new AbortController().signal, timings);
  policy.emitClose(1008);
  assert.equal(await pending, "policy");

  const invalid = new FakeSocket();
  const stop = monitorDeviceSocket(invalid as unknown as WebSocket, new AbortController().signal, timings);
  invalid.event("message", { data: JSON.stringify({ op: "run_command" }) });
  assert.equal(await stop, "policy");
  assert.equal(invalid.sent.length, 0);
  assert.equal(invalid.closeCount, 1);

  // A clean close from an ordinary transport restart still reconnects. Only
  // an explicit "superseded" reason stops duplicate Agent instances.
  const normal = new FakeSocket();
  const normalClose = monitorDeviceSocket(normal as unknown as WebSocket, new AbortController().signal, timings);
  normal.emitClose(1000, "server restart");
  assert.equal(await normalClose, "offline");
});

test("reconnect obtains a fresh challenge and stops on abort without executing commands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-reconnect-"));
  const keyPath = path.join(dir, "device.pem");
  const enrollment = newEnrollment("standalone-test");
  const deviceId = randomUUID();
  const controller = new AbortController();
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const states: string[] = [];
  let challengeCount = 0;
  try {
    await writeFile(keyPath, enrollment.privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    const send: typeof fetch = async () => {
      challengeCount++;
      return Response.json({ device_id: deviceId, nonce: String.fromCharCode(64 + challengeCount).repeat(24) });
    };
    const makeSocket = (_url: string, protocols: string[]): WebSocket => {
      assert.equal(protocols[0], "rc-v2");
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      if (sockets.length === 0) socket.onSend = () => queueMicrotask(() => socket.emitClose(1006));
      sockets.push(socket);
      queueMicrotask(() => socket.emitOpen());
      return socket as unknown as WebSocket;
    };
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, controller.signal, {
      send, makeSocket, heartbeat: timings,
      wait: async ms => { delays.push(ms); },
      onState: status => {
        states.push(status);
        if (status === "connected" && states.filter(x => x === "connected").length === 2) controller.abort();
      },
    });
    assert.equal(challengeCount, 2);
    assert.deepEqual(states, ["connected", "disconnected", "connected"]);
    assert.deepEqual(delays, [1000]);
    assert.equal(sockets.length, 2);
    assert.deepEqual(sockets[0]!.sent, ["rc-v2:ping"]);
    assert.deepEqual(sockets[1]!.sent, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("expected close and rejected policy stop retry loop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-policy-"));
  const keyPath = path.join(dir, "device.pem");
  const enrollment = newEnrollment("policy-host");
  const id = randomUUID();
  try {
    await writeFile(keyPath, enrollment.privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", id + "\n", { mode: 0o600 });
    for (const code of [1000, 1008]) {
      let sockets = 0;
      const statuses: string[] = [];
      await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, new AbortController().signal, {
        send: async () => Response.json({ device_id: id, nonce: "A".repeat(24) }),
        makeSocket: () => {
          sockets++;
          const socket = new FakeSocket();
          socket.readyState = WebSocket.CONNECTING;
          queueMicrotask(() => {
            socket.emitOpen();
            setTimeout(() => socket.emitClose(code, code === 1000 ? "superseded" : "policy"), 1);
          });
          return socket as unknown as WebSocket;
        },
        heartbeat: timings,
        wait: async () => { assert.fail("Expected close/policy must not retry"); },
        onState: status => statuses.push(status),
      });
      assert.equal(sockets, 1);
      assert.deepEqual(statuses, code === 1008 ? ["connected", "rejected"] : ["connected"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
