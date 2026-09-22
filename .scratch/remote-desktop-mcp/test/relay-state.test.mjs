// Logic-only regression tests. These DO NOT constitute real workerd/WebSocket or OAuth acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { RelayState } from "../relay-state.mjs";

function socket() {
  const sent = [];
  return { sent, closed: false,
    send(data) { sent.push(JSON.parse(data)); },
    close() { this.closed = true; } };
}

test("disconnected device fails without queuing work", async () => {
  const relay = new RelayState();
  await assert.rejects(relay.invoke("call-1", "sandbox_ping", { echo: "hi" }), /offline/);
  assert.equal(relay.pending.size, 0);
});

test("matching generation resolves, stale or duplicate response is rejected", async () => {
  const relay = new RelayState(), one = socket(), old = socket();
  relay.connect(one, "first");
  const result = relay.invoke("one", "sandbox_ping", { echo: "one" });
  assert.equal(one.sent[0].id, "one");
  assert.equal(relay.result(old, { id: "one", result: { echo: "bad" } }), false);
  assert.equal(relay.result(one, { id: "one", result: { echo: "one" } }), true);
  assert.deepEqual(await result, { echo: "one" });
  assert.equal(relay.result(one, { id: "one", result: { echo: "late" } }), false);
});

test("concurrent calls remain isolated by ID", async () => {
  const relay = new RelayState(), ws = socket();
  relay.connect(ws, "g");
  const first = relay.invoke("a", "sandbox_ping", { echo: "a" });
  const second = relay.invoke("b", "sandbox_ping", { echo: "b" });
  await assert.rejects(relay.invoke("a", "sandbox_ping", { echo: "bad" }), /duplicate_call_id/);
  relay.result(ws, { id: "b", result: { echo: "b" } });
  relay.result(ws, { id: "a", result: { echo: "a" } });
  assert.deepEqual(await Promise.all([first, second]), [{ echo: "a" }, { echo: "b" }]);
});

test("timed out work is removed and late results are ignored", async () => {
  const relay = new RelayState(), ws = socket();
  relay.connect(ws, "g");
  const pending = relay.invoke("slow", "sandbox_ping", { echo: "slow" }, 5);
  await assert.rejects(pending, /timeout/);
  assert.equal(relay.pending.size, 0);
  assert.equal(relay.result(ws, { id: "slow", result: {} }), false);
});

test("reconnection supersedes previous socket and rejects its requests", async () => {
  const relay = new RelayState(), old = socket(), current = socket();
  relay.connect(old, "one");
  const pending = relay.invoke("x", "sandbox_ping", { echo: "x" });
  relay.connect(current, "two");
  await assert.rejects(pending, /reconnected/);
  assert.equal(old.closed, true);
  relay.disconnect(old); // late close cannot disconnect new session
  const now = relay.invoke("y", "sandbox_ping", { echo: "y" });
  assert.equal(relay.result(old, { id: "y", result: { echo: "forged" } }), false);
  relay.result(current, { id: "y", result: { echo: "y" } });
  assert.deepEqual(await now, { echo: "y" });
});

test("revocation closes socket and rejects in-flight/new work", async () => {
  const relay = new RelayState(), ws = socket();
  relay.connect(ws, "g");
  const pending = relay.invoke("active", "sandbox_ping", { echo: "hi" });
  relay.revoke();
  await assert.rejects(pending, /revoked/);
  assert.equal(ws.closed, true);
  assert.equal(relay.connect(socket(), "again"), false);
  await assert.rejects(relay.invoke("next", "sandbox_ping", { echo: "hi" }), /revoked/);
});

test("disconnect rejects pending work and restored hibernated socket is usable", async () => {
  const relay = new RelayState(), ws = socket();
  relay.connect(ws, "before");
  const pending = relay.invoke("active", "sandbox_ping", { echo: "hi" });
  relay.disconnect(ws);
  await assert.rejects(pending, /offline/);
  const after = new RelayState();
  after.restore(ws, "before"); // getWebSockets + deserializeAttachment on wake
  const next = after.invoke("after", "sandbox_ping", { echo: "hi" });
  after.result(ws, { id: "after", result: { echo: "hi" } });
  assert.deepEqual(await next, { echo: "hi" });
});
