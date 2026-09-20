/* global process, fetch, URL, AbortSignal, console */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

// One-time recovery of previously recorded test-created IDs. NO discovery of
// or mutation to pre-existing user objects. No automatic retries of writes.
// Keep this separate from standard live suites to avoid new test objects.
const endpoint = process.env.RAINDROP_V3_TEST_URL ||
  "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const credential = process.env.MCP_ACCESS_TOKEN;
if (!credential) throw new Error("Missing isolated MCP credential");
const owned = {
  title: "mcp-v3-nested-fce4e056-3998-406c-b674-d1f9d651dc16",
  parentId: 75306620,
  childId: 75306622,
  bookmarkId: 1860540187,
};
const expectedLink = "https://example.com/?mcp-v3-nested=fce4e056-3998-406c-b674-d1f9d651dc16";
let bookmarkInCollection = true;
let bookmarkInTrash = false;
let bookmarkVerified = false;
let parentCleaned = false;
let childCleaned = false;
let bookmarkPurged = false;
const errors = [];

async function rpc(method, params = {}) {
  const response = await fetch(new URL("/mcp", endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("text/event-stream")
    ? (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      .find(item => item?.jsonrpc === "2.0" && (item.result || item.error))
    : await response.json();
  if (!payload) throw new Error(`Missing JSON-RPC reply: ${method}`);
  if (payload.error) throw new Error(`JSON-RPC ${payload.error.code}: ${method}`);
  return payload.result;
}

async function call(name, args) {
  const raw = await rpc("tools/call", { name, arguments: args });
  const result = raw?.structuredContent;
  if (raw?.isError || result?.ok !== true) {
    throw new Error(`${name}: ${result?.error?.code || "UNKNOWN"}, status ${result?.meta?.status || "unknown"}`);
  }
  return result;
}
async function inspectBookmark() {
  const data = (await call("raindrop_get", { id: owned.bookmarkId })).data?.item;
  assert.equal(data?._id, owned.bookmarkId, "Test bookmark ID differs");
  assert.equal(data?.title, owned.title, "Test bookmark title differs");
  assert.equal(data?.link, expectedLink, "Test bookmark link differs");
  assert(
    [owned.childId, owned.parentId, -99].includes(data?.collection?.$id),
    "Test bookmark moved to an unexpected source",
  );
  bookmarkVerified = true;
  return data.collection.$id;
}
async function removeEmpty(id, expectedTitle) {
  const data = (await call("collection_get", { id })).data?.item;
  assert.equal(data?._id, id, "Test collection ID differs");
  assert.equal(data?.title, expectedTitle, "Test collection title differs");
  const preview = await call("collection_delete", { id, onlyIfEmpty: true });
  assert.equal(preview.meta?.status, "preview");
  assert.deepEqual(preview.data?.descendantIds, []);
  const deleted = await call("collection_delete", {
    id, onlyIfEmpty: true, confirm: true, descendantIds: [],
  });
  assert.equal(deleted.meta?.status, "succeeded");
}

try {
  let initialized = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await rpc("initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "raindrop-v3-recovery", version: "1.0.0" },
      });
      initialized = true;
      break;
    } catch (error) {
      // Only reissue the read-only handshake when a newly rotated MCP
      // credential has not reached the edge. Never retry a mutation.
      if (!String(error).includes("HTTP 401 for initialize") || attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  assert(initialized, "Read-only direct MCP handshake did not complete");
  const currentSource = await inspectBookmark();
  console.log("PASS: exact test-owned bookmark identity and source verified");

  if (currentSource === -99) {
    bookmarkInCollection = false;
    bookmarkInTrash = true;
  } else {
    const preview = await call("raindrop_delete", { id: owned.bookmarkId });
    assert.equal(preview.meta?.status, "preview");
    assert.equal(preview.data?.targets?.[0]?.collectionId, currentSource);
    const deleted = await call("raindrop_delete", { id: owned.bookmarkId, confirm: true });
    assert.equal(deleted.meta?.status, "succeeded");
    // Acknowledged soft delete is not proof of current Trash source;
    // re-read before any permanent operation.
    bookmarkInCollection = false;
    console.log("PASS: exact test-owned bookmark was moved to Trash");
    const freshSource = await inspectBookmark();
    assert.equal(freshSource, -99, "Test bookmark was not found in Trash");
    bookmarkInTrash = true;
  }

  // Re-verify current source immediately before permanent deletion.
  if (bookmarkInTrash) {
    const freshSource = await inspectBookmark();
    assert.equal(freshSource, -99, "Test bookmark no longer in Trash");
    const preview = await call("raindrop_delete", {
      id: owned.bookmarkId, permanent: true,
    });
    assert.equal(preview.meta?.status, "preview");
    assert.equal(preview.data?.targets?.[0]?.id, owned.bookmarkId);
    assert.equal(preview.data?.targets?.[0]?.collectionId, -99);
    const removed = await call("raindrop_delete", {
      id: owned.bookmarkId, permanent: true, confirm: true,
    });
    assert.equal(removed.meta?.status, "succeeded");
    bookmarkPurged = true;
    console.log("PASS: exact-ID permanent deletion of test-owned Trash bookmark");
  }
} catch (error) {
  errors.push(`bookmark recovery: ${error?.message || String(error)}`);
}

// Safe cleanup of empty collections is possible only if bookmark is confirmed
// out of the collections. If the read was RATE_LIMITED, leave everything.
if (bookmarkVerified && !bookmarkInCollection) {
  try {
    await removeEmpty(owned.childId, `${owned.title}-child`);
    childCleaned = true;
    console.log("PASS: verified empty test child collection deleted");
  } catch (error) {
    errors.push(`child cleanup: ${error?.message || String(error)}`);
  }
  if (childCleaned) {
    try {
      await removeEmpty(owned.parentId, `${owned.title}-parent`);
      parentCleaned = true;
      console.log("PASS: verified empty test parent collection deleted");
    } catch (error) {
      errors.push(`parent cleanup: ${error?.message || String(error)}`);
    }
  }
}

if (errors.length || !parentCleaned || !childCleaned || !bookmarkPurged) {
  for (const error of errors) console.error(`BLOCKED: ${error}`);
  console.error(`TEST-OWNED RECOVERY INCOMPLETE: ${JSON.stringify({
    bookmarkVerified, bookmarkInCollection, bookmarkInTrash,
    bookmarkPurged, childCleaned, parentCleaned,
  })}`);
  process.exitCode = 1;
} else {
  console.log("PASS: all recorded test-only residual objects recovered without global cleanup");
}
