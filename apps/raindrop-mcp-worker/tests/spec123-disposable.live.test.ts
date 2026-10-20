import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

// Only a manual, owner-authorized credential-bearing job can enable this.
const enabled = Boolean(process.env.RAINDROP_ACCESS_TOKEN?.trim()) &&
  process.env.RUN_DESTRUCTIVE_LIVE_TESTS === "true" &&
  process.env.CONFIRM_DESTRUCTIVE_LIVE_TESTS === "DELETE_ONLY_TEST_BOOKMARKS";
const live = enabled ? describe : describe.skip;

live("Spec 123 disposable real API acceptance", () => {
  it("validates scoped atomic tool writes and deletes only disposable objects", async () => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    console.log("LIVE_DISPOSABLE_NONCE=" + nonce);
    const titles = ["spec123-a-" + nonce, "spec123-b-" + nonce];
    const ownedBookmarks = new Map<number, string>();
    const ownedCollections = new Set<number>();
    const service = new RaindropMCPService({
      accessToken: process.env.RAINDROP_ACCESS_TOKEN?.trim(), maxReadRetries: 0,
    });
    const client = new Client({ name: "spec123-live", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const get = (id: number) => service.raindropService.getBookmark(id, true);
    const owned = async (id: number) => {
      const item = await get(id);
      if (item._id !== id || item.link !== ownedBookmarks.get(id))
        throw new Error("Not a verified disposable bookmark: " + id);
      return item;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError || !result.structuredContent)
        throw new Error("MCP tool returned error: " + name);
      return result.structuredContent as Record<string, unknown> & {
        status?: string; bookmark?: { id: number }; collection?: { id: number };
        outcome?: string;
      };
    };
    const success = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.status).toBe("succeeded");
      return result;
    };
    const create = async (collectionId: number, suffix: string, tag: string) => {
      const url = "https://example.org/spec123/" + nonce + "/" + suffix;
      const result = await success("bookmark_create", {
        collectionId, url, title: "spec123 " + nonce + " " + suffix, tags: [tag],
      });
      const id = Number(result.bookmark?.id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("Creation ID not verifiable");
      ownedBookmarks.set(id, url);
      expect((await owned(id)).collection?.$id).toBe(collectionId);
      return id;
    };
    // Keep cleanup failure observable without a return/throw inside finally.
    const cleanup = async () => {
        for (const id of ownedBookmarks.keys()) {
          const item = await owned(id);
          if (item.collection?.$id !== -99) {
            const sourceId = item.collection?.$id;
            if (typeof sourceId !== "number" || (sourceId !== -1 && sourceId <= 0))
              throw new Error("Refuse to clean bookmark from an unknown source: " + id);
            await service.raindropService.deleteBookmark(id, sourceId);
            expect((await owned(id)).collection?.$id).toBe(-99);
          }
          await service.raindropService.deleteBookmark(id, -99);
          await expect(get(id)).rejects.toMatchObject({ code: "NOT_FOUND" });
        }
        const roots = await service.raindropService.getCollections(true);
        for (const root of roots) {
          if ([titles[0], titles[1], titles[0] + "-renamed"].includes(root.title))
            ownedCollections.add(root._id);
        }
        for (const id of ownedCollections) {
          const item = await service.raindropService.getCollection(id, true);
          if (![titles[0], titles[1], titles[0] + "-renamed"].includes(item.title))
            throw new Error("Collection identity mismatch: " + id);
          const preview = await service.raindropService.deleteCollectionPreviewFirst({ id });
          if (preview.total !== 1 || preview.collectionIds[0] !== id || preview.bookmarkCount !== 0)
            throw new Error("Refusing unsafe collection cleanup: " + id);
          const result = await service.raindropService.deleteCollectionPreviewFirst({
            id, confirm: true, expectedTotal: preview.total,
            collectionIds: preview.collectionIds, digest: preview.digest,
          });
          expect(result.succeeded).toEqual([id]);
        }
        console.log("LIVE_ISOLATED_CLEANUP_PASS");
    };
    await Promise.all([service.getServer().connect(st), client.connect(ct)]);
    try {
      for (const title of titles) {
        const result = await success("collection_create", { title, public: false });
        const id = Number(result.collection?.id);
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error("Collection creation ID not verifiable");
        ownedCollections.add(id);
        expect((await service.raindropService.getCollection(id, true)).title).toBe(title);
      }
      const [a, b] = [...ownedCollections];
      if (!a || !b) throw new Error("Disposable collections missing");
      await success("collection_update", { id: a, title: titles[0] + "-renamed" });
      expect((await service.raindropService.getCollection(a, true)).title).toBe(titles[0] + "-renamed");
      const ta = "s123a" + nonce, tb = "s123b" + nonce, tc = "s123c" + nonce;
      const x = await create(a, "x", ta);
      const y = await create(a, "y", tb);
      const z = await create(a, "z", tc);
      await success("bookmark_update", { id: x, note: "spec123-note-" + nonce });
      expect((await owned(x)).note).toBe("spec123-note-" + nonce);
      await success("bookmark_move", { id: x, collectionId: b });
      expect((await owned(x)).collection?.$id).toBe(b);

      // Wrong source membership must fail with no write.
      const rejected = await call("bookmark_batch_update", {
        collectionId: b, ids: [y], important: true,
      });
      expect(rejected).toMatchObject({ status: "failed", dispatched: false, notExecuted: [y] });
      expect((await owned(y)).collection?.$id).toBe(a);
      const batchTag = "s123batch" + nonce;
      const batch = await call("bookmark_batch_update", {
        collectionId: a, ids: [y, z], tagsToAdd: [batchTag], important: true,
      });
      expect(batch).toMatchObject({ status: "unknown", dispatched: true, acknowledged: true });
      for (const id of [y, z]) {
        const item = await owned(id);
        expect(item.collection?.$id).toBe(a);
        expect(item.important).toBe(true);
        expect(item.tags).toContain(batchTag);
      }

      const renamed = "s123r" + nonce, merged = "s123m" + nonce;
      await success("tag_rename", { collectionId: a, oldName: tb, newName: renamed });
      expect((await service.raindropService.getTags(a)).map(t => t._id)).toContain(renamed);
      await success("tag_merge", { collectionId: a, tagNames: [renamed, tc], newName: merged });
      expect((await service.raindropService.getTags(a)).map(t => t._id)).toContain(merged);
      await success("tag_delete", { collectionId: a, tagNames: [merged] });
      expect((await service.raindropService.getTags(a)).map(t => t._id)).not.toContain(merged);

      const deleted = await call("bookmark_batch_delete", { collectionId: a, ids: [y, z] });
      expect(deleted).toMatchObject({ status: "unknown", dispatched: true, acknowledged: true });
      for (const id of [y, z]) expect((await owned(id)).collection?.$id).toBe(-99);
      const single = await success("bookmark_delete", { id: x });
      expect(single.outcome).toBe("trashed");
      expect((await owned(x)).collection?.$id).toBe(-99);
      console.log("LIVE_SCOPED_WRITES_PASS");
    } finally {
      try {
        await cleanup();
      } finally {
        await client.close();
        await service.cleanup();
      }
    }
  }, 120_000);
});
