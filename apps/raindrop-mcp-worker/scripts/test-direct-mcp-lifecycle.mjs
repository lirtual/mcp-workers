import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

/**
 * Real-account acceptance. Mutates ONLY IDs created by this exact run.
 * Never empties Trash, merges/deletes global tags, or touches pre-existing IDs.
 * Fails closed if ownership/scope cannot be re-verified after a write.
 */
const baseUrl = process.env.RAINDROP_V3_TEST_URL ||
  "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const token = process.env.MCP_ACCESS_TOKEN;
if (!token) throw new Error("MCP_ACCESS_TOKEN required");
const runId = randomUUID();
const title = `mcp-v3-acceptance-${runId}`;
const testLink = `https://example.com/?mcp-v3-acceptance=${runId}`;
let collectionId = null;
let bookmarkId = null;
let safeToDeleteBookmark = false;
let safeToDeleteCollection = false;
const problems = [];

function ownedId(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a safe positive ID`);
  return value;
}

async function rpc(method, params = {}) {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status} for ${method}`);
  const type = response.headers.get("content-type") || "";
  let data;
  if (type.includes("text/event-stream")) {
    const events = (await response.text()).split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => {
        try { return JSON.parse(line.slice(5)); } catch { return null; }
      });
    data = events.find(event => event?.jsonrpc === "2.0" && (event?.result || event?.error));
  } else {
    data = await response.json();
  }
  if (!data) throw new Error(`No valid JSON-RPC response for ${method}`);
  if (data.error) throw new Error(`MCP protocol error ${data.error.code} for ${method}`);
  return data.result;
}

async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  const env = result?.structuredContent;
  if (result?.isError || env?.ok !== true) {
    const code = env?.error?.code || "UNKNOWN";
    throw new Error(`${name} failed with ${code}, status ${env?.meta?.status || "unknown"}`);
  }
  return env;
}

function assertOwnedCollection(item) {
  assert.equal(item?._id, collectionId, "Collection ID has changed");
  assert.equal(item?.title, `${title}-renamed`, "Test collection title no longer matches");
}
function assertOwnedBookmark(item) {
  assert.equal(item?._id, bookmarkId, "Bookmark ID has changed");
  assert.equal(item?.link, testLink, "Test bookmark link no longer matches");
  assert.equal(item?.collection?.$id, collectionId, "Bookmark source is not test collection");
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "raindrop-v3-isolated-lifecycle", version: "1.0.0" },
  });

  const created = await tool("collection_create", { title });
  collectionId = ownedId(created.data?.item?._id, "Created collection");
  const collection = (await tool("collection_get", { id: collectionId })).data?.item;
  assert.equal(collection?._id, collectionId);
  assert.equal(collection?.title, title);
  console.log("PASS: create/get owned test collection");

  await tool("collection_update", { id: collectionId, title: `${title}-renamed` });
  assertOwnedCollection((await tool("collection_get", { id: collectionId })).data?.item);
  safeToDeleteCollection = true;
  console.log("PASS: update/readback owned test collection");

  const createdBookmark = await tool("raindrop_create", {
    link: testLink,
    title,
    note: "Test-owned content only",
    collection: { $id: collectionId },
  });
  bookmarkId = ownedId(createdBookmark.data?.item?._id, "Created bookmark");
  assertOwnedBookmark((await tool("raindrop_get", { id: bookmarkId })).data?.item);
  safeToDeleteBookmark = true;
  console.log("PASS: create/get owned test bookmark");

  await tool("raindrop_update", { id: bookmarkId, note: "Updated test-owned content only" });
  const updated = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(updated);
  assert.equal(updated.note, "Updated test-owned content only");
  console.log("PASS: update/readback owned bookmark");
} catch (err) {
  problems.push(`lifecycle: ${err?.message || String(err)}`);
} finally {
  if (bookmarkId && collectionId) {
    try {
      const fresh = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
      assertOwnedBookmark(fresh);
      safeToDeleteBookmark = true;
    } catch (err) {
      safeToDeleteBookmark = false;
      problems.push(`bookmark ownership not reverified: ${err?.message || String(err)}`);
    }
    if (safeToDeleteBookmark) {
      try {
        const preview = await tool("raindrop_delete", { id: bookmarkId });
        assert.equal(preview.meta?.status, "preview");
        assert.equal(preview.data?.targets?.[0]?.collectionId, collectionId);
        const deleted = await tool("raindrop_delete", { id: bookmarkId, confirm: true });
        assert.equal(deleted.meta?.status, "succeeded");
        console.log("PASS: scoped preview/delete of owned test bookmark (moved to Trash)");
        bookmarkId = null;
      } catch (err) {
        problems.push(`bookmark cleanup: ${err?.message || String(err)}`);
      }
    }
  }

  if (collectionId && !bookmarkId) {
    try {
      const fresh = (await tool("collection_get", { id: collectionId })).data?.item;
      assertOwnedCollection(fresh);
      safeToDeleteCollection = true;
    } catch (err) {
      safeToDeleteCollection = false;
      problems.push(`collection ownership not reverified: ${err?.message || String(err)}`);
    }
    if (safeToDeleteCollection) {
      try {
        const preview = await tool("collection_delete", { id: collectionId, onlyIfEmpty: true });
        assert.equal(preview.meta?.status, "preview");
        assert.deepEqual(preview.data?.descendantIds, []);
        const deleted = await tool("collection_delete", {
          id: collectionId, confirm: true, onlyIfEmpty: true, descendantIds: [],
        });
        assert.equal(deleted.meta?.status, "succeeded");
        console.log("PASS: confirmed deletion of known-empty owned test collection");
        collectionId = null;
      } catch (err) {
        problems.push(`collection cleanup: ${err?.message || String(err)}`);
      }
    }
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  if (collectionId || bookmarkId) {
    // IDs and the unique run label are test-owned and are needed for targeted
    // recovery. Never print profile, original library items, or credentials.
    console.error(`TEST-OWNED CLEANUP REQUIRED: ${JSON.stringify({ title, collectionId, bookmarkId })}`);
  }
  process.exitCode = 1;
} else {
  console.log("PASS: direct isolated MCP test lifecycle and targeted cleanup");
}
