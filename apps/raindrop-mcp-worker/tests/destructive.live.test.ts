import { afterEach, describe, expect, it } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";


const runDestructiveLiveTest =
  Boolean(process.env.RAINDROP_ACCESS_TOKEN?.trim()) &&
  process.env.RUN_DESTRUCTIVE_LIVE_TESTS === "true" &&
  process.env.CONFIRM_DESTRUCTIVE_LIVE_TESTS === "DELETE_ONLY_TEST_BOOKMARKS";
const describeDestructive = runDestructiveLiveTest ? describe : describe.skip;

describeDestructive("RaindropService destructive live integration", () => {
  const service = new RaindropService({ accessToken: process.env.RAINDROP_ACCESS_TOKEN?.trim(), maxReadRetries: 0 });
  let createdBookmarkId: number | undefined;
  let createdBookmarkUrl: string | undefined;

  const permanentlyDeleteTestBookmark = async () => {
    if (createdBookmarkId === undefined || !createdBookmarkUrl) return;
    const id = createdBookmarkId;
    let bookmark = await service.getBookmark(id, true);
    if (bookmark._id !== id || bookmark.link !== createdBookmarkUrl)
      throw new Error(`Disposable bookmark identity mismatch (ID ${id})`);
    const source = bookmark.collection?.$id;
    if (typeof source !== "number" || !Number.isSafeInteger(source) ||
        (source !== -1 && source !== -99 && source <= 0))
      throw new Error(`Disposable bookmark source unverified (ID ${id})`);
    if (source !== -99) {
      await service.deleteBookmark(id, source);
      bookmark = await service.getBookmark(id, true);
    }
    if (bookmark._id !== id || bookmark.link !== createdBookmarkUrl ||
        bookmark.collection?.$id !== -99)
      throw new Error(`Disposable bookmark not verified in Trash (ID ${id})`);
    await service.deleteBookmark(id, -99);
    await expect(service.getBookmark(id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    createdBookmarkId = undefined;
    createdBookmarkUrl = undefined;
  };

  afterEach(async () => {
    await permanentlyDeleteTestBookmark();
  });

  it("creates, retrieves, and permanently removes only its own bookmark", async () => {
    const nonce = crypto.randomUUID();
    const url = `https://github.com/adeze/raindrop-mcp?e2e=${nonce}`;
    const bookmark = await service.createBookmark(undefined, {
      link: url,
      title: `raindrop-mcp destructive E2E ${nonce}`,
      tags: ["raindrop-mcp-e2e"],
    });
    createdBookmarkId = bookmark._id;
    createdBookmarkUrl = url;

    expect(createdBookmarkId).toEqual(expect.any(Number));
    const retrieved = await service.getBookmark(createdBookmarkId, true);
    expect(retrieved._id).toBe(createdBookmarkId);
    expect(retrieved.link).toBe(url);

    const id = createdBookmarkId;
    await permanentlyDeleteTestBookmark();
    await expect(service.getBookmark(id, true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  }, 30_000);

  it("creates, updates and removes one highlight on its own test bookmark", async () => {
    const nonce = crypto.randomUUID();
    const url = `https://example.com/?spec123-test-highlight=${nonce}`;
    const bookmark = await service.createBookmark(undefined, {
      link: url, title: `spec123-test-highlight-${nonce}`,
      tags: [`spec123-${nonce}`],
    });
    createdBookmarkId = bookmark._id;
    createdBookmarkUrl = url;
    const id = bookmark._id;
    expect(await service.getHighlights(id)).toEqual([]);
    const text = `spec123 highlight ${nonce}`;
    const created = await service.createHighlight(id, { text, color: "yellow" });
    expect(created.status).toBe("succeeded");
    if (created.status !== "succeeded") return;
    expect(created.highlight?.text).toBe(text);
    const hid = created.highlightId;
    expect((await service.getHighlights(id)).some(h => h._id === hid)).toBe(true);
    const updated = await service.updateHighlight(id, hid, { note: "spec123 test note" });
    expect(updated.status).toBe("succeeded");
    if (updated.status !== "succeeded") return;
    expect(updated.highlight?.note).toBe("spec123 test note");
    const deleted = await service.deleteHighlight(id, hid);
    expect(deleted.status).toBe("succeeded");
    expect(await service.getHighlights(id)).toEqual([]);
  }, 45_000);
});
