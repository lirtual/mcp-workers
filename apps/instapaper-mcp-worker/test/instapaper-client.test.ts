import { describe, expect, it, vi } from "vitest";
import { InstapaperClient } from "../src/instapaper/client.js";

const credentials = {
  consumerKey: "consumer",
  consumerSecret: "secret",
  oauthToken: "token",
  oauthTokenSecret: "token-secret",
};

describe("InstapaperClient", () => {
  it("reads bookmarks from the bookmarks/list object response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          user: { user_id: 1 },
          bookmarks: [{ bookmark_id: 123, url: "https://example.com", title: "Example" }],
          highlights: [],
          delete_ids: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new InstapaperClient(credentials, fetchMock as unknown as typeof fetch);

    const bookmarks = await client.listBookmarks({ limit: 25 });
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0].bookmark_id).toBe(123);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.instapaper.com/api/1/bookmarks/list",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses the v1.1 highlight list endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ highlight_id: 9, text: "hello" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new InstapaperClient(credentials, fetchMock as unknown as typeof fetch);

    await client.listHighlights(42);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.instapaper.com/api/1.1/bookmarks/42/highlights",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
