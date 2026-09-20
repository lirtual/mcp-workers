/* global process, fetch, URL, AbortSignal, console */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

// All mutations are confined to IDs created by this run. Never empty Trash or
// modify a personal bookmark. Do not replay an ambiguous submitted write.
const baseUrl = process.env.RAINDROP_V3_TEST_URL ||
  "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const auth = process.env.MCP_ACCESS_TOKEN;
if (!auth) throw new Error("Missing direct MCP test credential");
const run = randomUUID();
const prefix = `mcp-v3-scope-${run}`;
const collections = { a: null, b: null };
const bookmarks = { x: null, y: null };
const links = {
  x: `https://example.com/?mcp-v3-scope-x=${run}`,
  y: `https://example.com/?mcp-v3-scope-y=${run}`,
};
const errors = [];

function positive(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe ID`);
  return value;
}
async function rpc(method, params = {}) {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status} for ${method}`);
  const type = response.headers.get("content-type") || "";
  const result = type.includes("text/event-stream")
    ? (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      .find(item => item?.jsonrpc === "2.0" && (item.result || item.error))
    : await response.json();
  if (!result) throw new Error(`No JSON-RPC result for ${method}`);
  if (result.error) throw new Error(`MCP protocol error ${result.error.code}`);
  return result.result;
}
async function call(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  const envelope = response?.structuredContent;
  if (response?.isError || envelope?.ok !== true) {
    throw new Error(`${name}: ${envelope?.error?.code || "UNKNOWN"}, status ${envelope?.meta?.status || "unknown"}`);
  }
  return envelope;
}
async function getOwned(key) {
  const id = positive(bookmarks[key], `test bookmark ${key}`);
  const item = (await call("raindrop_get", { id })).data?.item;
  assert.equal(item?._id, id, "Bookmark ID changed");
  assert.equal(item?.link, links[key], "Bookmark link does not match this run");
  assert.equal(item?.title, `${prefix}-${key}`, "Bookmark title does not match this run");
  return item;
}
async function getCollection(key) {
  const id = positive(collections[key], `test collection ${key}`);
  const item = (await call("collection_get", { id })).data?.item;
  assert.equal(item?._id, id, "Collection ID changed");
  assert.equal(item?.title, `${prefix}-${key}`, "Collection title does not match this run");
  return item;
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "raindrop-v3-scope-isolation", version: "1.0.0" },
  });
  // Create two private collections and exactly two uniquely identifiable
  // bookmarks. Record server-assigned IDs before making any mutation.
  for (const key of ["a", "b"]) {
    const item = (await call("collection_create", { title: `${prefix}-${key}` })).data?.item;
    collections[key] = positive(item?._id, `created collection ${key}`);
    await getCollection(key);
  }
  for (const [key, source] of [["x", "a"], ["y", "b"]]) {
    const item = (await call("raindrop_create", {
      link: links[key], title: `${prefix}-${key}`,
      collection: { $id: collections[source] }, important: false,
    })).data?.item;
    bookmarks[key] = positive(item?._id, `created bookmark ${key}`);
    assert.equal((await getOwned(key)).collection?.$id, collections[source]);
  }
  console.log("PASS: two private test collections and source-separated owned bookmarks");

  const moved = await call("raindrop_bulk_update", {
    collectionId: collections.a, ids: [bookmarks.x],
    collection: { $id: collections.b },
  });
  assert.equal(moved.meta?.status, "succeeded");
  assert.equal((await getOwned("x")).collection?.$id, collections.b);
  assert.equal((await getOwned("y")).collection?.$id, collections.b);
  console.log("PASS: source-scoped move A -> B with independent B bookmark intact");

  // Wrong-source update is deliberately limited to our own Y bookmark.
  // An upstream rejection is acceptable, but any actual mutation in B is not.
  try {
    const wrong = await call("raindrop_bulk_update", {
      collectionId: collections.a, ids: [bookmarks.y], important: true,
    });
    assert(
      wrong.data?.modified === 0 || wrong.data?.modified === null,
      "Wrong-source update reported a nonzero modification",
    );
  } catch (error) {
    if (error?.name === "AssertionError") throw error;
    // An explicit upstream error may be a valid source-scoping rejection.
  }
  const guard = await getOwned("y");
  assert.equal(guard.collection?.$id, collections.b);
  assert.equal(guard.important, false, "Wrong-source update changed the B guard bookmark");
  console.log("PASS: wrong-source bulk update did not change independent B bookmark");

  const correct = await call("raindrop_bulk_update", {
    collectionId: collections.b, ids: [bookmarks.x], important: true,
  });
  assert.equal(correct.meta?.status, "succeeded");
  const x = await getOwned("x");
  assert.equal(x.collection?.$id, collections.b);
  assert.equal(x.important, true);
  console.log("PASS: correct source B bulk update and fresh readback");

  // Single-item move back also tests exact source semantics.
  await call("raindrop_update", {
    id: bookmarks.y, collection: { $id: collections.a },
  });
  assert.equal((await getOwned("y")).collection?.$id, collections.a);
  assert.equal((await getOwned("x")).collection?.$id, collections.b);
  console.log("PASS: owned single-bookmark move B -> A");
} catch (error) {
  errors.push(`scope lifecycle: ${error?.message || String(error)}`);
} finally {
  // This cleanup re-reads the ownership fields. Do not use a remembered
  // collectionId in a delete after moving an item.
  for (const key of ["x", "y"]) {
    if (!bookmarks[key]) continue;
    try {
      const fresh = await getOwned(key);
      const source = fresh.collection?.$id;
      assert(
        Object.values(collections).includes(source),
        "Test bookmark is no longer in a test-owned collection",
      );
      const preview = await call("raindrop_delete", { id: bookmarks[key] });
      assert.equal(preview.meta?.status, "preview");
      assert.equal(preview.data?.targets?.[0]?.collectionId, source);
      const deleted = await call("raindrop_delete", { id: bookmarks[key], confirm: true });
      assert.equal(deleted.meta?.status, "succeeded");
      bookmarks[key] = null;
      console.log(`PASS: targeted cleanup of owned bookmark ${key} (to Trash)`);
    } catch (error) {
      errors.push(`bookmark ${key} cleanup: ${error?.message || String(error)}`);
    }
  }
  if (!bookmarks.x && !bookmarks.y) {
    for (const key of ["a", "b"]) {
      if (!collections[key]) continue;
      try {
        await getCollection(key);
        const preview = await call("collection_delete", { id: collections[key], onlyIfEmpty: true });
        assert.equal(preview.meta?.status, "preview");
        assert.deepEqual(preview.data?.descendantIds, []);
        const deleted = await call("collection_delete", {
          id: collections[key], onlyIfEmpty: true, confirm: true, descendantIds: [],
        });
        assert.equal(deleted.meta?.status, "succeeded");
        collections[key] = null;
        console.log(`PASS: known-empty owned collection ${key} deleted`);
      } catch (error) {
        errors.push(`collection ${key} cleanup: ${error?.message || String(error)}`);
      }
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  // These identifiers refer ONLY to this run's test objects. Do not print
  // any existing user data, original bookmarks, or credentials.
  console.error(`TEST-OWNED CLEANUP REQUIRED: ${JSON.stringify({
    titlePrefix: prefix, collections, bookmarks,
  })}`);
  process.exitCode = 1;
} else {
  console.log("PASS: cross-collection isolation and targeted test-owned cleanup");
}
