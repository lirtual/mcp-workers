/* global process, fetch, URL, AbortSignal, console */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

// Never use an existing bookmark ID or empty account-wide Trash.
const baseUrl = process.env.RAINDROP_V3_TEST_URL ||
  "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const token = process.env.MCP_ACCESS_TOKEN;
if (!token) throw new Error("Missing direct MCP transport credential");
const run = randomUUID();
const title = `mcp-v3-nested-${run}`;
const link = `https://example.com/?mcp-v3-nested=${run}`;
let parentId = null;
let childId = null;
let bookmarkId = null;
let permanentlyDeleted = false;
const errors = [];

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
  const payload = type.includes("text/event-stream")
    ? (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      .find(item => item?.jsonrpc === "2.0" && (item.result || item.error))
    : await response.json();
  if (!payload) throw new Error(`No JSON-RPC result for ${method}`);
  if (payload.error) throw new Error(`MCP protocol error ${payload.error.code}`);
  return payload.result;
}
async function raw(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  return { envelope: result?.structuredContent, isError: result?.isError === true };
}
async function call(name, args) {
  const { envelope, isError } = await raw(name, args);
  if (isError || envelope?.ok !== true) {
    throw new Error(`${name}: ${envelope?.error?.code || "UNKNOWN"}, status ${envelope?.meta?.status || "unknown"}`);
  }
  return envelope;
}
function positive(id) {
  assert(Number.isSafeInteger(id) && id > 0, "Expected safe positive test-owned ID");
  return id;
}
async function getCollection(id, expectedTitle) {
  const item = (await call("collection_get", { id })).data?.item;
  assert.equal(item?._id, id);
  assert.equal(item?.title, expectedTitle, "Test collection title/ownership mismatch");
  return item;
}
async function getBookmark() {
  const item = (await call("raindrop_get", { id: bookmarkId })).data?.item;
  assert.equal(item?._id, bookmarkId);
  assert.equal(item?.link, link);
  assert.equal(item?.title, title);
  return item;
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "raindrop-v3-nested-trash-test", version: "1.0.0" },
  });
  parentId = positive((await call("collection_create", { title: `${title}-parent` })).data?.item?._id);
  childId = positive((await call("collection_create", {
    title: `${title}-child`, parent: { $id: parentId },
  })).data?.item?._id);
  const parent = await getCollection(parentId, `${title}-parent`);
  const child = await getCollection(childId, `${title}-child`);
  assert.equal(child.parent?.$id, parentId);
  assert.equal(parent.parent?.$id ?? null, null);
  const tree = (await call("collection_tree", {})).data?.roots || [];
  const ownRoot = tree.find(x => x._id === parentId);
  assert(ownRoot?.children?.some(x => x._id === childId), "Nested child absent from collection_tree");
  console.log("PASS: nested test collection created and appears under exact parent");

  const preview = await call("collection_delete", { id: parentId });
  assert.equal(preview.meta?.status, "preview");
  assert.deepEqual(preview.data?.descendantIds, [childId]);
  console.log("PASS: parent delete preview lists exact child without deleting either");

  for (const args of [
    { id: parentId, parent: { $id: childId } },
    { id: childId, parent: null },
  ]) {
    const expected = args.parent === null ? "FEATURE_UNVERIFIED" : "VALIDATION_ERROR";
    const result = await raw("collection_update", args);
    assert.equal(result.isError, true);
    assert.equal(result.envelope?.error?.code, expected);
  }
  assert.equal((await getCollection(childId, `${title}-child`)).parent?.$id, parentId);
  console.log("PASS: cycle and unverified parent-to-root writes remain fail-closed");

  bookmarkId = positive((await call("raindrop_create", {
    link, title, note: "Test-created disposable bookmark",
    collection: { $id: childId },
  })).data?.item?._id);
  assert.equal((await getBookmark()).collection?.$id, childId);
  const trashPreview = await call("raindrop_delete", { id: bookmarkId });
  assert.equal(trashPreview.meta?.status, "preview");
  assert.equal(trashPreview.data?.targets?.[0]?.collectionId, childId);
  const trashed = await call("raindrop_delete", { id: bookmarkId, confirm: true });
  assert.equal(trashed.meta?.status, "succeeded");
  assert.equal((await getBookmark()).collection?.$id, -99, "Exact test bookmark must now be in Trash");
  console.log("PASS: exact test bookmark moved to Trash and read back");

  const permanentPreview = await call("raindrop_delete", { id: bookmarkId, permanent: true });
  assert.equal(permanentPreview.meta?.status, "preview");
  assert.equal(permanentPreview.data?.targets?.[0]?.collectionId, -99);
  const removed = await call("raindrop_delete", {
    id: bookmarkId, permanent: true, confirm: true,
  });
  assert.equal(removed.meta?.status, "succeeded");
  const gone = await raw("raindrop_get", { id: bookmarkId });
  assert(gone.isError || gone.envelope?.ok === false, "Permanently removed test bookmark is still readable");
  permanentlyDeleted = true;
  bookmarkId = null;
  console.log("PASS: preview/permanent deletion of exact test-created Trash ID, never whole Trash");
} catch (error) {
  errors.push(`nested/trash lifecycle: ${error?.message || String(error)}`);
} finally {
  // Cleanup can proceed only if the exact test bookmark is no longer in a
  // collection. Never accidentally delete a nonempty subtree.
  let bookmarkIsInCollection = false;
  if (bookmarkId) {
    try {
      const item = await getBookmark();
      bookmarkIsInCollection = item.collection?.$id === childId || item.collection?.$id === parentId;
      if (!bookmarkIsInCollection && item.collection?.$id !== -99) {
        errors.push("Test bookmark source changed unexpectedly; collection cleanup blocked");
        bookmarkIsInCollection = true;
      }
    } catch (error) {
      errors.push(`Bookmark state unverified: ${error?.message || String(error)}`);
      bookmarkIsInCollection = true;
    }
  }
  if (!bookmarkIsInCollection) {
    for (const [key, id, expectedTitle] of [
      ["child", childId, `${title}-child`],
      ["parent", parentId, `${title}-parent`],
    ]) {
      if (!id) continue;
      try {
        await getCollection(id, expectedTitle);
        const preview = await call("collection_delete", { id, onlyIfEmpty: true });
        assert.equal(preview.meta?.status, "preview");
        assert.deepEqual(preview.data?.descendantIds, []);
        const result = await call("collection_delete", {
          id, onlyIfEmpty: true, confirm: true, descendantIds: [],
        });
        assert.equal(result.meta?.status, "succeeded");
        if (key === "child") childId = null;
        else parentId = null;
        console.log(`PASS: known-empty owned ${key} collection deleted`);
      } catch (error) {
        errors.push(`${key} cleanup: ${error?.message || String(error)}`);
      }
    }
  }
}
if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  console.error(`TEST-OWNED CLEANUP REQUIRED: ${JSON.stringify({
    title, parentId, childId, bookmarkId, permanentlyDeleted,
  })}`);
  process.exitCode = 1;
} else {
  console.log("PASS: nested collection and exact-ID permanent Trash deletion without global purge");
}
