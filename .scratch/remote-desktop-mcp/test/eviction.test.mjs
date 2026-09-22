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

test("revoked device remains revoked across eviction without stale socket", async () => {
  // Separate object: revocation closes an active socket asynchronously; do not
  // mix an unacknowledged WebSocket close with the storage-persistence check.
  const stub = env.DEVICE.get(env.DEVICE.idFromName("revocation-proof"));
  const revoked = await stub.fetch("https://internal/revoke", { method: "POST" });
  expect(revoked.status).toBe(200);
  await evictDurableObject(stub);
  const denied = await stub.fetch("https://internal/device", { headers: { Upgrade: "websocket" } });
  expect(denied.status).toBe(403);
  const blocked = await stub.fetch("https://internal/invoke", {
    method: "POST",
    body: JSON.stringify({ id: "after-revoke", tool: "sandbox_ping", arguments: { echo: "no" } }),
  });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({ error: "revoked" });
});
