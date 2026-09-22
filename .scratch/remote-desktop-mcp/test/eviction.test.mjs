// THROWAWAY #173: actual cloudflare:test eviction, not synthetic new RelayState().
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { test, expect } from "vitest";

test("hibernated connection restores from attachment", async () => {
  const stub = env.DEVICE.get(env.DEVICE.idFromName("scratch-only"));
  const response = await stub.fetch("https://internal/device", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket.accept();
  console.log("eviction-proof: websocket accepted");

  // Hibernation keeps the device socket connected, discards in-memory RelayState.
  await evictDurableObject(stub, { webSockets: "hibernate" });
  console.log("eviction-proof: first eviction completed");
  expect(socket.readyState).toBe(WebSocket.OPEN);

  const message = new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
  });
  const pending = stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({ id: "hibernation-proof", tool: "sandbox_ping", arguments: { echo: "wake" } }),
  });
  const call = await message;
  console.log("eviction-proof: message delivered after eviction");
  expect(call).toMatchObject({ type: "call", id: "hibernation-proof", tool: "sandbox_ping" });
  socket.send(JSON.stringify({ type: "result", id: call.id, result: { echo: "wake" } }));
  const result = await pending;
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ result: { echo: "wake" } });
  console.log("eviction-proof: round trip succeeded");

  socket.close(1000, "done");
});


test("revocation survives forced eviction after draining the HTTP response", async () => {
  // The eviction helper waits for in-flight requests. A response with an
  // unread body may leave the stub request open until the 30-second deadline.
  const stub = env.DEVICE.get(env.DEVICE.idFromName("revocation-proof-drained"));
  const revoked = await stub.fetch("https://internal/revoke", { method: "POST" });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ revoked: true });

  await evictDurableObject(stub);
  const reconnect = await stub.fetch("https://internal/device", { headers: { Upgrade: "websocket" } });
  expect(reconnect.status).toBe(403);
  expect(await reconnect.json()).toEqual({ error: "revoked" });

  const blocked = await stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({ id: "after-revoke", tool: "sandbox_ping", arguments: { echo: "no" } }),
  });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({ error: "revoked" });
});

test("live device revoke closes connection and survives forced eviction", async () => {
  const stub = env.DEVICE.get(env.DEVICE.idFromName("connected-revoke-proof"));
  const response = await stub.fetch("https://internal/device", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  socket.accept();

  const revoked = await stub.fetch("https://internal/revoke", { method: "POST" });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ revoked: true });

  // This explicitly tests a previously connected device, rather than only a
  // new/revoked DO. The fixture drains the response before forcing eviction.
  await evictDurableObject(stub, { webSockets: "close" });
  const denied = await stub.fetch("https://internal/device", {
    headers: { Upgrade: "websocket" },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "revoked" });

  const blocked = await stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({ id: "revoke-live-restart", tool: "sandbox_ping", arguments: { echo: "blocked" } }),
  });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({ error: "revoked" });
});


// Graceful eviction must not be mistaken for a forced crash. The helper waits
// for active HTTP requests to drain before replacing in-memory RelayState.
test("eviction during a pending invoke waits for its response then restores socket", async () => {
  const stub = env.DEVICE.get(env.DEVICE.idFromName("active-call-drain-proof"));
  const connected = await stub.fetch("https://internal/device", {
    headers: { Upgrade: "websocket" },
  });
  expect(connected.status).toBe(101);
  const socket = connected.webSocket;
  expect(socket).toBeDefined();
  socket.accept();

  const nextMessage = () => new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
  });
  // Begin the request and observe its dispatch before initiating eviction.
  const firstMessage = nextMessage();
  const inFlight = stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({
      id: "before-graceful-eviction", tool: "sandbox_ping", arguments: { echo: "first" },
    }),
  });
  const firstCall = await firstMessage;
  expect(firstCall).toMatchObject({ type: "call", id: "before-graceful-eviction" });

  let evictionFinished = false;
  const eviction = evictDurableObject(stub, { webSockets: "hibernate" })
    .then(() => { evictionFinished = true; });
  await Promise.resolve();
  expect(evictionFinished).toBe(false);

  // The existing in-flight request must be able to complete even though
  // eviction was requested. Consume its response body before awaiting eviction.
  socket.send(JSON.stringify({
    type: "result", id: firstCall.id, result: { echo: "first" },
  }));
  const firstResponse = await inFlight;
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.json()).toEqual({ result: { echo: "first" } });
  await eviction;
  expect(evictionFinished).toBe(true);
  expect(socket.readyState).toBe(WebSocket.OPEN);

  // A fresh request rehydrates the original hibernated connection.
  const restoredMessage = nextMessage();
  const restoredCall = stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({
      id: "after-graceful-eviction", tool: "sandbox_ping", arguments: { echo: "second" },
    }),
  });
  const secondCall = await restoredMessage;
  expect(secondCall).toMatchObject({ type: "call", id: "after-graceful-eviction" });
  socket.send(JSON.stringify({
    type: "result", id: secondCall.id, result: { echo: "second" },
  }));
  const secondResponse = await restoredCall;
  expect(secondResponse.status).toBe(200);
  expect(await secondResponse.json()).toEqual({ result: { echo: "second" } });
  socket.close(1000, "done");
});
