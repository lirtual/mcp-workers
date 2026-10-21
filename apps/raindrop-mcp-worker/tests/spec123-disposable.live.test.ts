import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import RaindropService from "../src/services/raindrop.service.js";
import { raiseG0Failures, type RecordedFailure } from "./g0-failure-report.js";

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
    const attemptedUrls = new Set<string>();
    const ownedCollections = new Set<number>();
    const service = new RaindropMCPService({
      accessToken: process.env.RAINDROP_ACCESS_TOKEN?.trim(), maxReadRetries: 0,
    });
    const client = new Client({ name: "spec123-live", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const cleanupService = new RaindropService({
      accessToken: process.env.RAINDROP_ACCESS_TOKEN?.trim(), maxReadRetries: 0,
    });
    const get = (id: number, source = service.raindropService) => source.getBookmark(id, true);
    const owned = async (id: number, source = service.raindropService) => {
      const item = await get(id, source);
      if (item._id !== id || item.link !== ownedBookmarks.get(id))
        throw new Error("Not a verified disposable bookmark: " + id);
      return item;
    };
    const call = async (name: string, args: Record<string, unknown>, allowFailed = false) => {
      const result = await client.callTool({ name, arguments: args });
      const body = result.structuredContent as Record<string, unknown> | undefined;
      if (!body || (result.isError && !(allowFailed && body.status === "failed")))
        throw new Error("Unexpected MCP tool error: " + name);
      return body as Record<string, unknown> & {
        status?: string; bookmark?: { id: number }; collection?: { id: number };
        outcome?: string;
      };
    };
    const success = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      expect(result.status).toBe("succeeded");
      return result;
    };
    const create = async (collectionId: number, suffix: string, tag: string, important = false) => {
      const url = "https://example.org/spec123/" + nonce + "/" + suffix;
      // Record the URL before POST: lost replies may leave an untracked
      // bookmark. Never announce a clean run if its ID cannot be verified.
      attemptedUrls.add(url);
      const result = await success("bookmark_create", {
        collectionId, url, title: "spec123 " + nonce + " " + suffix, tags: [tag], important,
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
      const problems: string[] = [];
      for (const url of attemptedUrls) {
        if (![...ownedBookmarks.values()].includes(url))
          problems.push("bookmark create not confirmed (inspect exact URL): " + url);
      }
      // Do not let one failed cleanup strand other independently verified
      // objects. Every write remains restricted to exact test-owned IDs.
      for (const id of ownedBookmarks.keys()) {
        try {
          const item = await owned(id, cleanupService);
          if (item.collection?.$id !== -99) {
            const sourceId = item.collection?.$id;
            if (typeof sourceId !== "number" || (sourceId !== -1 && sourceId <= 0))
              throw new Error("Unverified source");
            await cleanupService.deleteBookmark(id, sourceId);
            expect((await owned(id, cleanupService)).collection?.$id).toBe(-99);
          }
          await cleanupService.deleteBookmark(id, -99);
          await expect(get(id, cleanupService)).rejects.toMatchObject({ code: "NOT_FOUND" });
        } catch (error) {
          problems.push("bookmark " + id + ": " +
            (error instanceof Error ? error.message : "unknown outcome"));
        }
      }
      try {
        const roots = await cleanupService.getCollections(true);
        for (const root of roots) {
          if ([titles[0], titles[1], titles[0] + "-renamed"].includes(root.title))
            ownedCollections.add(root._id);
        }
      } catch (error) {
        problems.push("collection discovery: " +
          (error instanceof Error ? error.message : "unknown outcome"));
      }
      for (const id of ownedCollections) {
        try {
          const item = await cleanupService.getCollection(id, true);
          if (![titles[0], titles[1], titles[0] + "-renamed"].includes(item.title))
            throw new Error("Identity changed");
          const preview = await cleanupService.deleteCollectionPreviewFirst({ id });
          if (preview.total !== 1 || preview.collectionIds[0] !== id || preview.bookmarkCount !== 0)
            throw new Error("Refusing nonempty or expanded collection cleanup");
          const result = await cleanupService.deleteCollectionPreviewFirst({
            id, confirm: true, expectedTotal: preview.total,
            collectionIds: preview.collectionIds, digest: preview.digest,
          });
          expect(result.succeeded).toEqual([id]);
        } catch (error) {
          problems.push("collection " + id + ": " +
            (error instanceof Error ? error.message : "unknown outcome"));
        }
      }
      // DELETE acknowledgements alone do not establish that the two private
      // disposable collections actually disappeared. Re-read the root list
      // without cache, including uncertain POSTs recorded by exact title.
      try {
        const roots = await cleanupService.getCollections(true);
        const expectedTitles = new Set([titles[0], titles[1], titles[0] + "-renamed"]);
        const leftovers = roots.filter(root =>
          ownedCollections.has(root._id) || expectedTitles.has(root.title));
        if (leftovers.length)
          problems.push("disposable collections still present after cleanup: " +
            leftovers.map(item => String(item._id)).join(", "));
      } catch (error) {
        problems.push("final collection readback unavailable: " +
          (error instanceof Error ? error.message : String(error)));
      }
      if (problems.length) throw new Error("Disposable cleanup incomplete: " + problems.join("; "));
      console.log("LIVE_ISOLATED_CLEANUP_PASS");
    };
    await Promise.all([service.getServer().connect(st), client.connect(ct)]);
    let primaryFailure: RecordedFailure = null;
    try {
      for (const title of titles) {
        const result = await success("collection_create", { title, public: false });
        const id = Number(result.collection?.id);
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error("Collection creation ID not verifiable");
        ownedCollections.add(id);
        expect((await service.raindropService.getCollection(id, true)).title).toBe(title);
        if (ownedCollections.size === 1) {
          // Before creating further disposable objects, check that the exact
          // fresh, read-only deletion preview can safely enumerate this root.
          // The prior real G0 run failed at this step only during cleanup.
          const preview = await cleanupService.deleteCollectionPreviewFirst({ id });
          if (preview.rootId !== id || preview.total !== 1 ||
              preview.collectionIds[0] !== id || preview.bookmarkCount !== 0)
            throw new Error("Disposable collection deletion preflight is not safe");
        }
      }
      const [a, b] = [...ownedCollections];
      if (!a || !b) throw new Error("Disposable collections missing");
      await success("collection_update", { id: a, title: titles[0] + "-renamed" });
      expect((await service.raindropService.getCollection(a, true)).title).toBe(titles[0] + "-renamed");
      const ta = "s123a" + nonce, tb = "s123b" + nonce, tc = "s123c" + nonce;
      // Create one Favorite and two non-Favorites in the same isolated scope.
      // This checks both sides of the real important:false exclusion without
      // modifying any existing bookmarks or increasing write operations.
      const x = await create(a, "x", ta, true);
      const y = await create(a, "y", tb, false);
      const z = await create(a, "z", tc, false);
      expect((await owned(x)).important).toBe(true);
      expect((await owned(y)).important).toBe(false);
      const favorites = await call("bookmark_search", {
        collection: a, important: true, page: 0, perPage: 10, skipCache: true,
      });
      const nonFavorites = await call("bookmark_search", {
        collection: a, important: false, page: 0, perPage: 10, skipCache: true,
      });
      if (favorites.count !== 1) {
        // Diagnose only this UUID-scoped private test collection. These are
        // extra READS on failure, never retries of any write or global search.
        // Do not log bookmark contents, raw API responses, or credentials.
        const diagnostic: Record<string, unknown> = { filteredCount: favorites.count };
        try {
          const unfiltered = await call("bookmark_search", {
            collection: a, page: 0, perPage: 10, skipCache: true,
          });
          diagnostic.unfilteredCount = unfiltered.count;
          diagnostic.favoritedIdVisibleUnfiltered =
            (unfiltered.items as { id: number }[]).some(item => item.id === x);
        } catch {
          diagnostic.unfilteredRead = "unavailable";
        }
        try {
          const stats = await service.raindropService.getBookmarkFilters(a);
          diagnostic.officialFavoriteCount = stats.important ?? "unavailable";
        } catch {
          diagnostic.officialFavoriteCount = "unavailable";
        }
        console.log("LIVE_FAVORITE_DIAGNOSTIC=" + JSON.stringify(diagnostic));
      }
      expect(favorites.count).toBe(1);
      expect((favorites.items as { id: number }[]).map(item => item.id)).toEqual([x]);
      expect(nonFavorites.count).toBe(2);
      expect((nonFavorites.items as { id: number }[]).map(item => item.id).sort((l, r) => l - r))
        .toEqual([y, z].sort((l, r) => l - r));
      console.log("LIVE_FAVORITE_EXCLUSION_PASS");
      await success("bookmark_update", { id: x, note: "spec123-note-" + nonce });
      expect((await owned(x)).note).toBe("spec123-note-" + nonce);
      await success("bookmark_move", { id: x, collectionId: b });
      expect((await owned(x)).collection?.$id).toBe(b);

      // Wrong source membership must fail with no write.
      const rejected = await call("bookmark_batch_update", {
        collectionId: b, ids: [y], important: true,
      }, true);
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
    } catch (error) {
      primaryFailure = { error };
    }
    let cleanupFailure: RecordedFailure = null;
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = { error };
    } finally {
      try {
        await client.close();
        await service.cleanup();
      } catch (error) {
        cleanupFailure = cleanupFailure
          ? { error: new AggregateError(
              [cleanupFailure.error, error], "Cleanup and connection close failed",
            ) }
          : { error };
      }
    }
    raiseG0Failures(primaryFailure, cleanupFailure);
  }, 120_000);
});
