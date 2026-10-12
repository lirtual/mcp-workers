import assert from "node:assert/strict";
import test from "node:test";
import { ownsProcessGroup } from "../src/sessions.ts";

test("a reused process-group number is rejected after the original child exits", () => {
  const originalChild = { pid: 1729, exitCode: 0, signalCode: null };
  assert.equal(ownsProcessGroup(originalChild, 1729), false);
  assert.equal(ownsProcessGroup({ pid: 1729, exitCode: null, signalCode: null }, 1729), true);
  assert.equal(ownsProcessGroup({ pid: 1730, exitCode: null, signalCode: null }, 1729), false);
  assert.equal(ownsProcessGroup({ pid: 1729, exitCode: null, signalCode: "SIGTERM" }, 1729), false);
});
