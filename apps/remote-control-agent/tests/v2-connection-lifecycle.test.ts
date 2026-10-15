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


test("revoked or unrecognized device stops retrying instead of hammering auth endpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-permanent-auth-"));
  const keyPath = path.join(dir, "device.pem");
  const enrollment = newEnrollment("denied-device");
  const deviceId = randomUUID();
  try {
    await writeFile(keyPath, enrollment.privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    for (const httpStatus of [401, 403, 404]) {
      let calls = 0;
      const states: string[] = [];
      await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, new AbortController().signal, {
        send: async () => {
          calls++;
          return new Response(null, { status: httpStatus });
        },
        makeSocket: () => { assert.fail("Denied identity must never attempt WSS"); },
        wait: async () => { assert.fail("Permanent identity denial must never retry"); },
        onState: value => states.push(value),
      });
      assert.equal(calls, 1);
      assert.deepEqual(states, ["rejected"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("identity recovery with an unknown approved key stops without creating a new pairing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-recover-rejected-"));
  const keyPath = path.join(dir, "device.pem");
  try {
    await writeFile(keyPath, newEnrollment("unknown-host").privateKeyPem, { mode: 0o600 });
    let attempts = 0;
    const states: string[] = [];
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, new AbortController().signal, {
      send: async () => { attempts++; return new Response(null, { status: 404 }); },
      wait: async () => { assert.fail("Recovery rejection is permanent until re-paired"); },
      onState: value => states.push(value),
    });
    assert.equal(attempts, 1);
    assert.deepEqual(states, ["rejected"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("temporary 503 remains retryable and respects stop signal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-temporary-auth-"));
  const keyPath = path.join(dir, "device.pem");
  const controller = new AbortController();
  const states: string[] = [];
  const waits: number[] = [];
  const deviceId = randomUUID();
  try {
    await writeFile(keyPath, newEnrollment("retryable-host").privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, controller.signal, {
      send: async () => new Response(null, { status: 503 }),
      wait: async ms => { waits.push(ms); controller.abort(); },
      onState: value => states.push(value),
    });
    assert.deepEqual(states, ["disconnected"]);
    assert.deepEqual(waits, [1000]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unexpected negotiated WSS subprotocol is permanent, not an infinite reconnect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-bad-protocol-"));
  const keyPath = path.join(dir, "device.pem");
  const deviceId = randomUUID();
  let attempts = 0;
  try {
    await writeFile(keyPath, newEnrollment("protocol-host").privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    const statuses: string[] = [];
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, new AbortController().signal, {
      send: async () => Response.json({ device_id: deviceId, nonce: "A".repeat(24) }),
      makeSocket: () => {
        attempts++;
        const socket = new FakeSocket();
        socket.protocol = "rc-v3";
        socket.readyState = WebSocket.CONNECTING;
        queueMicrotask(() => socket.emitOpen());
        return socket as unknown as WebSocket;
      },
      wait: async () => { assert.fail("Protocol mismatch must never reconnect"); },
      onState: value => statuses.push(value),
    });
    assert.equal(attempts, 1);
    assert.deepEqual(statuses, ["rejected"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("periodic authorization check wakes DO separately while routine pongs stay automatic", async () => {
  const socket = new FakeSocket();
  const stop = new AbortController();
  socket.onSend = (frame: string) => {
    if (frame === "rc-v2:ping") queueMicrotask(() => socket.pong());
    if (frame.startsWith("rc-v2:auth:")) queueMicrotask(() => socket.event("message", { data: frame.replace("rc-v2:auth:", "rc-v2:auth-ok:") }));
  };
  const result = monitorDeviceSocket(socket as unknown as WebSocket, stop.signal,
    { intervalMs: 16, timeoutMs: 10, authIntervalMs: 40 });
  await new Promise(resolve => setTimeout(resolve, 135));
  assert.ok(socket.sent.filter(x => x === "rc-v2:ping").length >= 3);
  assert.ok(socket.sent.filter(x => /^rc-v2:auth:[a-f0-9]{32}$/.test(x)).length >= 2,
    "DO must be explicitly checked at the slower authorization cadence");
  assert.equal(socket.closeCount, 0);
  stop.abort();
  assert.equal(await result, "aborted");
});

test("automatic pongs never replace an overdue authorization check", async () => {
  const socket = new FakeSocket();
  socket.onSend = frame => {
    if (frame === "rc-v2:ping") queueMicrotask(() => socket.pong());
    // A stale/partitioned session may still get transport pongs, but not an
    // authorized response from the DO. The Agent must eventually close.
  };
  const result = await monitorDeviceSocket(socket as unknown as WebSocket,
    new AbortController().signal, { intervalMs: 15, timeoutMs: 9, authIntervalMs: 34 });
  assert.equal(result, "offline");
  assert.ok(socket.sent.some(x => /^rc-v2:auth:[a-f0-9]{32}$/.test(x)));
  assert.ok(socket.sent.includes("rc-v2:ping"));
  assert.equal(socket.closeCount, 1);
});

test("unexpected unsolicited authorization success is rejected", async () => {
  const socket = new FakeSocket();
  const result = monitorDeviceSocket(socket as unknown as WebSocket,
    new AbortController().signal, { intervalMs: 16, timeoutMs: 10, authIntervalMs: 40 });
  socket.event("message", { data: "rc-v2:auth-ok" });
  assert.equal(await result, "policy");
  assert.equal(socket.closeCount, 1);
});

test("a delayed authorization ACK for the previous check never renews the current check", async () => {
  const socket = new FakeSocket();
  const requests: string[] = [];
  socket.onSend = (frame: string) => {
    if (frame === "rc-v2:ping") queueMicrotask(() => socket.pong());
    if (frame.startsWith("rc-v2:auth:")) {
      requests.push(frame);
      if (requests.length === 1) {
        queueMicrotask(() => socket.event("message", {
          data: frame.replace("rc-v2:auth:", "rc-v2:auth-ok:"),
        }));
      } else {
        // Delayed/duplicated response to the first check, not this request.
        queueMicrotask(() => socket.event("message", {
          data: requests[0]!.replace("rc-v2:auth:", "rc-v2:auth-ok:"),
        }));
      }
    }
  };
  const result = await monitorDeviceSocket(socket as unknown as WebSocket,
    new AbortController().signal, { intervalMs: 16, timeoutMs: 10, authIntervalMs: 40 });
  assert.equal(result, "offline");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
  assert.match(requests[0]!, /^rc-v2:auth:[a-f0-9]{32}$/);
  assert.equal(socket.closeCount, 1);
});

test("a stale ACK is ignored while the matching current ACK is accepted", async () => {
  const socket = new FakeSocket();
  const stop = new AbortController();
  const requests: string[] = [];
  socket.onSend = frame => {
    if (frame === "rc-v2:ping") queueMicrotask(() => socket.pong());
    if (frame.startsWith("rc-v2:auth:")) {
      requests.push(frame);
      if (requests.length === 2) {
        socket.event("message", { data: requests[0]!.replace("rc-v2:auth:", "rc-v2:auth-ok:") });
      }
      queueMicrotask(() => socket.event("message", {
        data: frame.replace("rc-v2:auth:", "rc-v2:auth-ok:"),
      }));
    }
  };
  const pending = monitorDeviceSocket(socket as unknown as WebSocket, stop.signal,
    { intervalMs: 16, timeoutMs: 10, authIntervalMs: 40 });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.ok(requests.length >= 2);
  assert.equal(socket.closeCount, 0);
  stop.abort();
  assert.equal(await pending, "aborted");
});


test("rapidly flapping successful handshakes keep increasing backoff instead of always retrying after one second", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-flapping-"));
  const keyPath = path.join(dir, "device.pem");
  const deviceId = randomUUID();
  const controller = new AbortController();
  const waits: number[] = [];
  let handshakes = 0;
  try {
    await writeFile(keyPath, newEnrollment("flapping-host").privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, controller.signal, {
      send: async () => Response.json({ device_id: deviceId, nonce: "A".repeat(24) }),
      makeSocket: () => {
        handshakes++;
        const socket = new FakeSocket();
        socket.readyState = WebSocket.CONNECTING;
        queueMicrotask(() => socket.emitOpen());
        setTimeout(() => socket.emitClose(1006), 1);
        return socket as unknown as WebSocket;
      },
      heartbeat: { intervalMs: 60, timeoutMs: 30, authIntervalMs: 300 },
      wait: async ms => {
        waits.push(ms);
        if (waits.length === 6) controller.abort();
      },
    });
    assert.equal(handshakes, 6);
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a genuinely stable session resets the retry backoff to enable fast recovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-stable-reset-"));
  const keyPath = path.join(dir, "device.pem");
  const deviceId = randomUUID();
  const controller = new AbortController();
  const waits: number[] = [];
  let handshakes = 0;
  try {
    await writeFile(keyPath, newEnrollment("healthy-host").privateKeyPem, { mode: 0o600 });
    await writeFile(keyPath + ".device-id", deviceId + "\n", { mode: 0o600 });
    await maintainAuthenticatedDeviceSession("https://agent.example/", keyPath, controller.signal, {
      send: async () => Response.json({ device_id: deviceId, nonce: "A".repeat(24) }),
      makeSocket: () => {
        handshakes++;
        const socket = new FakeSocket();
        socket.readyState = WebSocket.CONNECTING;
        if (handshakes === 2) {
          socket.onSend = frame => {
            if (frame === "rc-v2:ping") queueMicrotask(() => socket.pong());
          };
        }
        queueMicrotask(() => socket.emitOpen());
        setTimeout(() => socket.emitClose(1006), handshakes === 2 ? 180 : 1);
        return socket as unknown as WebSocket;
      },
      heartbeat: { intervalMs: 30, timeoutMs: 20, authIntervalMs: 400 },
      wait: async ms => {
        waits.push(ms);
        if (waits.length === 4) controller.abort();
      },
    });
    assert.equal(handshakes, 4);
    assert.deepEqual(waits, [1000, 1000, 2000, 4000]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
