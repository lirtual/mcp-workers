import assert from "node:assert/strict";
import test from "node:test";
import { V2OwnerCoordinator } from "../src/worker.ts";

test("paired DO denies legacy GUI read and effect requests before socket dispatch", async () => {
  let dispatched = 0;
  const owner = new V2OwnerCoordinator({
    storage: { get: async () => { throw Error("should not read device"); } },
    getWebSockets: () => { dispatched++; return []; },
  } as unknown as DurableObjectState);
  const device_id = "11111111-1111-4111-8111-111111111111";
  for (const [route, tools] of [
    ["/read", ["computer_status", "computer_observe", "browser_snapshot", "browser_tabs"]],
    ["/operation", ["computer_stop", "browser_start", "browser_click", "browser_tabs"]],
  ] as const) for (const tool of tools) {
    const body = { device_id, tool, arguments: {},
      ...(route === "/operation" ? {operation_id: "retired-628"} : {}) };
    const response = await owner.fetch(new Request("https://v2.internal"+route, {
      method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400, tool);
  }
  assert.equal(dispatched, 0);
});
