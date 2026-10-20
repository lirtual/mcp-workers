import assert from "node:assert/strict";
import test from "node:test";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";
const revoked = "33333333-3333-4333-8333-333333333333";

test("owner rename changes only the label; duplicate names require UUID disambiguation", async () => {
  const rows = new Map<string, unknown>([
    ["device:" + one, { device_id: one, name: "Windows", public_key: "key1", fingerprint: "fp1", approved_at: Date.now(), revoked: false }],
    ["device:" + two, { device_id: two, name: "Ubuntu", public_key: "key2", fingerprint: "fp2", approved_at: Date.now(), revoked: false }],
    ["device:" + revoked, { device_id: revoked, name: "retired", public_key: "key3", fingerprint: "fp3", approved_at: Date.now(), revoked: true }],
    ["session:epoch:" + one, "unchanged-epoch"],
  ]);
  const original = structuredClone(rows.get("device:" + one));
  const storage = {
    async get<T>(key: string): Promise<T | undefined> { return rows.get(key) as T | undefined; },
    async put(key: string, value: unknown) { rows.set(key, value); },
    async delete(key: string) { return rows.delete(key); },
    async list<T>({prefix, limit}: {prefix: string;limit: number}) {
      return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async transaction<T>(fn: (txn: typeof storage) => Promise<T>): Promise<T> { return fn(storage); },
  };
  const owner = new V2OwnerCoordinator({
    storage,
    getWebSockets: () => [],
  } as unknown as DurableObjectState);
  const env = {
    MCP_ACCESS_TOKEN: "private-owner",
    DEVICE_COORDINATOR: {
      idFromName: () => "single-owner-v2",
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          owner.fetch(input instanceof Request ? input : new Request(input, init)),
      }),
    },
  } as unknown as Env;
  const rpc = async (name: string, args: unknown, token = "private-owner") => {
    const result = await worker.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}),
    }), env);
    return { status: result.status, value: await result.json() as {
      result?: {isError?: boolean; content?: Array<{text: string}>};
    }};
  };

  assert.equal((await rpc("device_rename", {device_id: one, name: "Ubuntu"}, "invalid")).status, 401);
  for (const args of [
    {device_id: "Windows", name: "Ubuntu"}, {device_id: one.slice(0, 8), name: "Ubuntu"},
    {device_id: one, name: ""}, {device_id: one, name: "bad\nname"},
    {device_id: one, name: " ".repeat(3)}, {device_id: one, name: "a".repeat(65)},
    {device_id: one, name: "Ubuntu", public_key: "tamper"},
  ]) {
    assert.equal((await rpc("device_rename", args)).value.result?.isError, true);
  }
  assert.deepEqual(rows.get("device:" + one), original);
  assert.equal((await rpc("device_rename", { device_id: revoked, name: "revived" })).value.result?.isError, true);

  const rename = await rpc("device_rename", {device_id: one, name: "Ubuntu"});
  assert.equal(rename.value.result?.isError, false);
  assert.deepEqual(rows.get("device:" + one), {...original as object, name: "Ubuntu"});
  assert.equal(rows.get("session:epoch:" + one), "unchanged-epoch");
  const listed = await rpc("list_devices", {});
  const devices = JSON.parse(listed.value.result!.content![0]!.text) as Array<{
    device_id: string; name: string; display_name?: string; name_ambiguous?: boolean;
  }>;
  assert.equal(devices.length, 2);
  assert.ok(devices.every(d => d.name === "Ubuntu" && d.name_ambiguous === true));
  assert.deepEqual(new Set(devices.map(d => d.display_name)), new Set([
    "Ubuntu (11111111)", "Ubuntu (22222222)",
  ]));
  assert.deepEqual(new Set(devices.map(d => d.device_id)), new Set([one, two]));

  const restore = await rpc("device_rename", {device_id: one, name: "Windows"});
  assert.equal(restore.value.result?.isError, false);
  const distinct = JSON.parse((await rpc("list_devices", {})).value.result!.content![0]!.text) as Array<{
    display_name?: string; name_ambiguous?: boolean;
  }>;
  assert.ok(distinct.every(d => d.display_name === undefined && d.name_ambiguous === undefined));
});
