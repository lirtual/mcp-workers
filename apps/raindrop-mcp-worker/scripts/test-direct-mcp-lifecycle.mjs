/* global process, fetch, URL, AbortSignal, console */
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
const ownedTags = {
  first: `mcp-v3-first-${runId}`,
  second: `mcp-v3-second-${runId}`,
  keep: `mcp-v3-keep-${runId}`,
  renamed: `mcp-v3-renamed-${runId}`,
  merged: `mcp-v3-merged-${runId}`,
};
let collectionId = null;
let bookmarkId = null;
let safeToDeleteBookmark;
let safeToDeleteCollection;
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
  console.log("PASS: update/readback owned test collection");

  // Explicitly verify that the random test tags do not exist already.
  const globalTags = await tool("tag_list", { page: 0, perpage: 50 });
  assert.equal(globalTags.meta?.hasMore, false, "Cannot establish global test-tag uniqueness");
  const existing = new Set(globalTags.data?.items?.map(item => item._id));
  for (const name of Object.values(ownedTags)) {
    assert(!existing.has(name), "A proposed test tag already exists");
  }

  const createdBookmark = await tool("raindrop_create", {
    link: testLink,
    title,
    note: "Test-owned content only",
    tags: [ownedTags.first, ownedTags.second, ownedTags.keep],
    collection: { $id: collectionId },
  });
  bookmarkId = ownedId(createdBookmark.data?.item?._id, "Created bookmark");
  assertOwnedBookmark((await tool("raindrop_get", { id: bookmarkId })).data?.item);
  console.log("PASS: create/get owned test bookmark");

  await tool("raindrop_update", { id: bookmarkId, note: "Updated test-owned content only" });
  const updated = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(updated);
  assert.equal(updated.note, "Updated test-owned content only");
  console.log("PASS: update/readback owned bookmark");

  const tags = (await tool("tag_list", { collectionId, page: 0, perpage: 10 })).data?.items;
  assert(Array.isArray(tags), "Scoped tag list response missing items");
  console.log("PASS: scoped tag_list on owned collection");

  const renameArgs = {
    scope: "collection", collectionId, tags: [ownedTags.first], replace: ownedTags.renamed,
  };
  const renamePreview = await tool("tag_rename", renameArgs);
  assert.equal(renamePreview.meta?.status, "preview");
  const renamed = await tool("tag_rename", { ...renameArgs, confirm: true });
  assert.equal(renamed.meta?.status, "succeeded");
  let currentTags = (await tool("raindrop_get", { id: bookmarkId })).data?.item?.tags;
  assert(Array.isArray(currentTags) && currentTags.includes(ownedTags.renamed));
  assert(!currentTags.includes(ownedTags.first));
  assert(currentTags.includes(ownedTags.second) && currentTags.includes(ownedTags.keep));
  console.log("PASS: preview/rename and readback of unique test-owned tag");

  const mergeArgs = {
    scope: "collection", collectionId,
    tags: [ownedTags.renamed, ownedTags.second], replace: ownedTags.merged,
  };
  const mergePreview = await tool("tag_merge", mergeArgs);
  assert.equal(mergePreview.meta?.status, "preview");
  const merged = await tool("tag_merge", { ...mergeArgs, confirm: true });
  assert.equal(merged.meta?.status, "succeeded");
  currentTags = (await tool("raindrop_get", { id: bookmarkId })).data?.item?.tags;
  assert(Array.isArray(currentTags) && currentTags.includes(ownedTags.merged));
  assert(!currentTags.includes(ownedTags.renamed) && !currentTags.includes(ownedTags.second));
  assert(currentTags.includes(ownedTags.keep));
  console.log("PASS: preview/merge and readback of unique test-owned tags");

  const deleteArgs = { scope: "collection", collectionId, tags: [ownedTags.merged] };
  const tagPreview = await tool("tag_delete", deleteArgs);
  assert.equal(tagPreview.meta?.status, "preview");
  const deletedTag = await tool("tag_delete", { ...deleteArgs, confirm: true });
  assert.equal(deletedTag.meta?.status, "succeeded");
  currentTags = (await tool("raindrop_get", { id: bookmarkId })).data?.item?.tags;
  assert(Array.isArray(currentTags) && !currentTags.includes(ownedTags.merged));
  assert(currentTags.includes(ownedTags.keep), "Untouched test tag must remain intact");
  console.log("PASS: preview/delete and readback of unique test-owned tag");


  const bulk = await tool("raindrop_bulk_update", {
    collectionId, ids: [bookmarkId], important: true,
  });
  assert.equal(bulk.meta?.status, "succeeded");
  const bulkUpdated = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(bulkUpdated);
  assert.equal(bulkUpdated.important, true);
  console.log("PASS: source-scoped bulk update and readback of owned bookmark");

  const highlightText = `mcp-v3-highlight-${runId}`;
  await tool("highlight_create", {
    raindropId: bookmarkId, text: highlightText, note: "owned highlight", color: "yellow",
  });
  const highlighted = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(highlighted);
  const candidates = (highlighted?.highlights || []).filter(h => h.text === highlightText);
  assert.equal(candidates.length, 1, "Created highlight must be identifiable uniquely on owned bookmark");
  const highlightId = candidates[0]?._id;
  assert(typeof highlightId === "string" && highlightId.length > 0, "Created highlight _id must be a nonempty string");
  console.log("PASS: create/readback highlight on owned bookmark");

  const highlightUpdated = await tool("highlight_update", {
    raindropId: bookmarkId, _id: highlightId, note: "updated owned highlight",
  });
  assert.equal(highlightUpdated.meta?.status, "succeeded");
  const afterHighlightUpdate = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(afterHighlightUpdate);
  assert.equal(afterHighlightUpdate.highlights?.find(h => h._id === highlightId)?.note, "updated owned highlight");
  console.log("PASS: note-only highlight update and readback");

  const highlightPreview = await tool("highlight_delete", { raindropId: bookmarkId, _id: highlightId });
  assert.equal(highlightPreview.meta?.status, "preview");
  const highlightDeleted = await tool("highlight_delete", {
    raindropId: bookmarkId, _id: highlightId, confirm: true,
  });
  assert.equal(highlightDeleted.meta?.status, "succeeded");
  const afterHighlightDelete = (await tool("raindrop_get", { id: bookmarkId })).data?.item;
  assertOwnedBookmark(afterHighlightDelete);
  assert(!afterHighlightDelete.highlights?.some(h => h._id === highlightId), "Owned highlight must be absent after confirmed delete");
  console.log("PASS: preview/delete/readback owned highlight");
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
