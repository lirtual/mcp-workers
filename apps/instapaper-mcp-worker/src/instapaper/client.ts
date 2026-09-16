import { signFormRequest } from "./oauth.js";
import { toSafeInstapaperError, InstapaperApiError } from "./errors.js";
import type {
  Bookmark,
  BookmarkListResponse,
  Folder,
  Highlight,
  InstapaperCredentials,
  InstapaperUser,
} from "./types.js";

const API_BASE = "https://www.instapaper.com/api";

function firstOfType<T extends { type?: string }>(items: T[], type: string): T {
  const item = items.find((entry) => entry.type === type) ?? items[0];
  if (!item) throw new InstapaperApiError(`Instapaper returned no ${type} object.`);
  return item;
}

export class InstapaperClient {
  constructor(
    private readonly credentials: InstapaperCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    params: Record<string, string> = {},
    responseKind: "json" | "text" = "json",
  ): Promise<unknown> {
    const url = `${API_BASE}${path}`;
    const signed = signFormRequest({
      url,
      consumerKey: this.credentials.consumerKey,
      consumerSecret: this.credentials.consumerSecret,
      token: {
        token: this.credentials.oauthToken,
        tokenSecret: this.credentials.oauthTokenSecret,
      },
      params,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      });
    } catch {
      throw new InstapaperApiError("Instapaper request failed due to a network error.");
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw toSafeInstapaperError(response.status, body);
    }

    if (responseKind === "text") return response.text();

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new InstapaperApiError("Instapaper returned an invalid JSON response.", 503);
    }
  }

  async verifyCredentials(): Promise<InstapaperUser> {
    const response = (await this.request("/1/account/verify_credentials")) as Array<InstapaperUser & { type?: string }>;
    return firstOfType(response, "user");
  }

  async listBookmarks(options: {
    folder?: string;
    tag?: string;
    limit?: number;
  } = {}): Promise<Bookmark[]> {
    const params: Record<string, string> = {};
    if (options.folder) params.folder_id = options.folder;
    if (options.tag && !options.folder) params.tag = options.tag;
    if (options.limit) params.limit = String(options.limit);
    const response = (await this.request("/1/bookmarks/list", params)) as BookmarkListResponse;
    return Array.isArray(response.bookmarks) ? response.bookmarks : [];
  }

  async getArticleContent(bookmarkId: number): Promise<string> {
    return (await this.request(
      "/1/bookmarks/get_text",
      { bookmark_id: String(bookmarkId) },
      "text",
    )) as string;
  }

  async addBookmark(input: {
    url: string;
    title?: string;
    description?: string;
    folderId?: number;
  }): Promise<Bookmark> {
    const params: Record<string, string> = { url: input.url };
    if (input.title) params.title = input.title;
    if (input.description) params.description = input.description;
    if (input.folderId !== undefined) params.folder_id = String(input.folderId);
    const response = (await this.request("/1/bookmarks/add", params)) as Array<Bookmark & { type?: string }>;
    return firstOfType(response, "bookmark");
  }

  async setStarred(bookmarkId: number, starred: boolean): Promise<Bookmark> {
    const response = (await this.request(
      starred ? "/1/bookmarks/star" : "/1/bookmarks/unstar",
      { bookmark_id: String(bookmarkId) },
    )) as Array<Bookmark & { type?: string }>;
    return firstOfType(response, "bookmark");
  }

  async setArchived(bookmarkId: number, archived: boolean): Promise<Bookmark> {
    const response = (await this.request(
      archived ? "/1/bookmarks/archive" : "/1/bookmarks/unarchive",
      { bookmark_id: String(bookmarkId) },
    )) as Array<Bookmark & { type?: string }>;
    return firstOfType(response, "bookmark");
  }

  async moveBookmark(bookmarkId: number, folderId: number): Promise<Bookmark> {
    const response = (await this.request("/1/bookmarks/move", {
      bookmark_id: String(bookmarkId),
      folder_id: String(folderId),
    })) as Array<Bookmark & { type?: string }>;
    return firstOfType(response, "bookmark");
  }

  async deleteBookmark(bookmarkId: number): Promise<void> {
    await this.request("/1/bookmarks/delete", { bookmark_id: String(bookmarkId) });
  }

  async listFolders(): Promise<Folder[]> {
    const response = (await this.request("/1/folders/list")) as Array<Folder & { type?: string }>;
    return response.filter((entry) => !entry.type || entry.type === "folder");
  }

  async createFolder(title: string): Promise<Folder> {
    const response = (await this.request("/1/folders/add", { title })) as Array<Folder & { type?: string }>;
    return firstOfType(response, "folder");
  }

  async listHighlights(bookmarkId: number): Promise<Highlight[]> {
    const response = (await this.request(`/1.1/bookmarks/${bookmarkId}/highlights`)) as Highlight[];
    return response;
  }

  async addHighlight(bookmarkId: number, text: string, position = 0): Promise<Highlight> {
    const response = (await this.request(`/1.1/bookmarks/${bookmarkId}/highlight`, {
      text,
      position: String(position),
    })) as Array<Highlight & { type?: string }>;
    return firstOfType(response, "highlight");
  }
}
