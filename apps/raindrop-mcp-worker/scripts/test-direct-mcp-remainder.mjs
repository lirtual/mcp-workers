/* global process, fetch, URL, AbortSignal, console */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

// Direct-MCP live test: ONLY this run's collection and bookmark IDs.
// No blanket Trash cleanup, no unverified destructive gate and no automatic
// retry of a submitted write.
const baseUrl = process.env.RAINDROP_V3_TEST_URL ||
  "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const auth = process.env.MCP_ACCESS_TOKEN;
if (!auth) throw new Error("MCP_ACCESS_TOKEN is required");
const runId = randomUUID();
const title = `mcp-v3-remainder-${runId}`;
const link = `https://example.com/?mcp-v3-remainder=${runId}`;
let rootId = null;
let childId = null;
let bookmarkId = null;
let softDeleted = false;
let permanentlyDeleted = false;
const errors = [];
function ownedId(value, kind) {
  assert(Number.isSafeInteger(value) && value > 0, `${kind}: expected positive safe ID`);
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
  const payload = type.includes("text/event-stream")
    ? (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      .find(item => item?.jsonrpc === "2.0" && (item.result || item.error))
    : await response.json();
  if (!payload) throw new Error(`Missing JSON-RPC response for ${method}`);
  if (payload.error) throw new Error(`MCP protocol error ${payload.error.code}`);
  return payload.result;
}

async function result(name, args) {
  const x = await rpc("tools/call", { name, arguments: args });
  return { isError: x?.isError === true, env: x?.structuredContent };
}
async function call(name, args) {
  const x = await result(name, args);
  if (x.isError || x.env?.ok !== true) {
    throw new Error(`${name}: ${x.env?.error?.code || "UNKNOWN"}, status ${x.env?.meta?.status || "unknown"}`);
  }
  return x.env;
}
async function readRoot() {
  const item = (await call("collection_get", { id: rootId })).data?.item;
  assert.equal(item?._id, rootId);
  assert.equal(item?.title, title);
  return item;
}
async function readChild() {
  const item = (await call("collection_get", { id: childId })).data?.item;
  assert.equal(item?._id, childId);
  assert.equal(item?.title, `${title}-child`);
  assert.equal(item?.parent?.$id, rootId);
  return item;
}
async function readOwnedBookmark(source) {
  const item = (await call("raindrop_get", { id: bookmarkId })).data?.item;
  assert.equal(item?._id, bookmarkId, "Returned bookmark differs from the created ID");
  assert.equal(item?.link, link, "Bookmark link differs from this run");
  assert.equal(item?.title, title, "Bookmark title differs from this run");
  assert.equal(item?.collection?.$id, source, "Bookmark source unexpectedly changed");
  return item;
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "raindrop-v3-live-remainder", version: "1.0.0" },
  });

  // Plan-gated read-only filters: report when entitlement is unavailable;
  // never treat a feature gate as an empty successful page.
  for (const kind of ["duplicates", "broken"]) {
    const audit = await result("library_audit", {
      kind, collectionId: 0, page: 0, perpage: 1,
    });
    if (audit.isError) {
      const code = audit.env?.error?.code;
      assert(
        ["FEATURE_UNAVAILABLE", "FEATURE_UNVERIFIED"].includes(code),
        `Unexpected ${kind} audit error: ${code}`,
      );
      console.log(`BLOCKED: read-only ${kind} audit entitlement/operator not verified (${code})`);
    } else {
      assert.equal(audit.env?.ok, true);
      assert(Array.isArray(audit.env?.data?.items));
      console.log(`READ-ONLY: ${kind} operator returned a page; semantic correctness remains unverified`);
    }
  }

  const root = (await call("collection_create", { title })).data?.item;
  rootId = ownedId(root?._id, "root collection");
  await readRoot();
  const child = (await call("collection_create", {
    title: `${title}-child`, parent: { $id: rootId },
  })).data?.item;
  childId = ownedId(child?._id, "child collection");
  await readChild();
  console.log("PASS: create/readback of owned parent and child collections");

  // Compile-time safety gate. It must not issue a move-to-root write.
  const gated = await result("collection_update", { id: childId, parent: null });
  assert.equal(gated.isError, true);
  assert.equal(gated.env?.error?.code, "FEATURE_UNVERIFIED");
  await readChild();
  console.log("PASS: parent-to-root remains gated and child parent is unchanged");

  const created = (await call("raindrop_create", {
    link, title, collection: { $id: rootId },
  })).data?.item;
  bookmarkId = ownedId(created?._id, "test bookmark");
  await readOwnedBookmark(rootId);

  const gatedDuplicate = await result("duplicates_delete", {
    collectionId: rootId, ids: [bookmarkId], confirm: true,
  });
  assert.equal(gatedDuplicate.isError, true);
  assert.equal(gatedDuplicate.env?.error?.code, "FEATURE_UNVERIFIED");
  await readOwnedBookmark(rootId);
  console.log("PASS: duplicate execution gate rejects a test-owned candidate");

  const preview = await call("raindrop_delete", { id: bookmarkId });
  assert.equal(preview.meta?.status, "preview");
  assert.equal(preview.data?.targets?.[0]?.collectionId, rootId);
  const soft = await call("raindrop_delete", { id: bookmarkId, confirm: true });
  assert.equal(soft.meta?.status, "succeeded");
  softDeleted = true;
  console.log("PASS: source-scoped soft delete of uniquely owned bookmark");

  // Re-read the exact ID and establish Trash as its CURRENT source. If the
  // official API does not expose it after soft-delete, stop: never guess.
  await readOwnedBookmark(-99);
  const permanentPreview = await call("raindrop_delete", { id: bookmarkId, permanent: true });
  assert.equal(permanentPreview.meta?.status, "preview");
  assert.equal(permanentPreview.data?.targets?.[0]?.id, bookmarkId);
  assert.equal(permanentPreview.data?.targets?.[0]?.collectionId, -99);
  assert.equal(permanentPreview.data?.permanent, true);
  const permanent = await call("raindrop_delete", {
    id: bookmarkId, permanent: true, confirm: true,
  });
  assert.equal(permanent.meta?.status, "succeeded");
  permanentlyDeleted = true;
  console.log("PASS: exact-ID permanent delete of ONLY this run's Trash bookmark");

  // Post-delete verification must not silently accept a still-readable item.
  const afterDelete = await result("raindrop_get", { id: bookmarkId });
  assert.equal(afterDelete.isError, true, "Deleted bookmark must not remain readable");
  console.log("PASS: permanently deleted test ID is not readable");
  bookmarkId = null;
} catch (error) {
  errors.push(`remainder: ${error?.message || String(error)}`);
} finally {
  // Cleanup only exact IDs, regardless of previous test failures. The Trash
  // item is left in place if its source/ownership cannot be verified.
  if (bookmarkId && !softDeleted) {
    try {
      await readOwnedBookmark(rootId);
      const before = await call("raindrop_delete", { id: bookmarkId });
      assert.equal(before.data?.targets?.[0]?.collectionId, rootId);
      const deleted = await call("raindrop_delete", { id: bookmarkId, confirm: true });
      assert.equal(deleted.meta?.status, "succeeded");
      softDeleted = true;
      console.log("PASS: fallback targeted soft-delete of owned test bookmark");
    } catch (error) {
      errors.push(`bookmark cleanup: ${error?.message || String(error)}`);
    }
  }
  if (childId) {
    try {
      await readChild();
      const preview = await call("collection_delete", { id: childId, onlyIfEmpty: true });
      assert.equal(preview.meta?.status, "preview");
      assert.deepEqual(preview.data?.descendantIds, []);
      const deleted = await call("collection_delete", {
        id: childId, onlyIfEmpty: true, confirm: true, descendantIds: [],
      });
      assert.equal(deleted.meta?.status, "succeeded");
      childId = null;
      console.log("PASS: targeted removal of owned empty child");
    } catch (error) {
      errors.push(`child cleanup: ${error?.message || String(error)}`);
    }
  }
  if (rootId && !childId && (!bookmarkId || softDeleted || permanentlyDeleted)) {
    try {
      await readRoot();
      const preview = await call("collection_delete", { id: rootId, onlyIfEmpty: true });
      assert.equal(preview.meta?.status, "preview");
      assert.deepEqual(preview.data?.descendantIds, []);
      const deleted = await call("collection_delete", {
        id: rootId, onlyIfEmpty: true, confirm: true, descendantIds: [],
      });
      assert.equal(deleted.meta?.status, "succeeded");
      rootId = null;
      console.log("PASS: targeted removal of owned empty root");
    } catch (error) {
      errors.push(`root cleanup: ${error?.message || String(error)}`);
    }
  }
}
if (errors.length) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  console.error(`TEST-OWNED CLEANUP REQUIRED: ${JSON.stringify({
    title, rootId, childId, bookmarkId, softDeleted, permanentlyDeleted,
  })}`);
  process.exitCode = 1;
} else {
  console.log("PASS: remaining safe real-account checks and owned-only cleanup");
}
