import { AppError } from "../mcp/errors";

interface Envelope<T> { code?: number; message?: string; data?: T; }

export class OpenListClient {
  constructor(private readonly baseUrl: URL, private readonly token: string, private readonly timeoutMs: number) {}

  async request<T>(method: "GET" | "POST", endpoint: string, options: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
    const url = new URL(`/api/${endpoint.replace(/^\//, "")}`, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: this.token,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      if (response.status === 401) throw new AppError("UPSTREAM_AUTH_FAILED", "OpenList rejected the configured token");
      if (response.status === 404) throw new AppError("NOT_FOUND", "OpenList resource was not found");
      if (!response.ok) throw new AppError("UPSTREAM_UNAVAILABLE", `OpenList returned HTTP ${response.status}`);
      const envelope = await response.json() as Envelope<T> | T;
      if (envelope && typeof envelope === "object" && "code" in envelope) {
        const e = envelope as Envelope<T>;
        if (e.code !== undefined && e.code !== 200) {
          if (e.code === 401) throw new AppError("UPSTREAM_AUTH_FAILED", e.message ?? "OpenList rejected the configured token", { upstreamCode: e.code });
          if (e.code === 404) throw new AppError("NOT_FOUND", e.message ?? "OpenList resource was not found", { upstreamCode: e.code });
          throw new AppError("OPENLIST_ERROR", e.message ?? `OpenList error ${e.code}`, { upstreamCode: e.code });
        }
        return e.data as T;
      }
      return envelope as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new AppError("UPSTREAM_TIMEOUT", "OpenList request timed out");
      throw new AppError("UPSTREAM_UNAVAILABLE", error instanceof Error ? error.message : "OpenList request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(path: string, fileName: string, bytes: Uint8Array): Promise<unknown> {
    const url = new URL("/api/fs/put", this.baseUrl);
    url.searchParams.set("as_task", "true");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: this.token,
          "File-Path": `${path === "/" ? "" : path.replace(/\/$/, "")}/${fileName}`,
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
        signal: controller.signal,
      });
      if (response.status === 401) throw new AppError("UPSTREAM_AUTH_FAILED", "OpenList rejected the configured token");
      if (!response.ok) throw new AppError("UPSTREAM_UNAVAILABLE", `OpenList upload returned HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({}));
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new AppError("UPSTREAM_TIMEOUT", "OpenList upload timed out");
      throw new AppError("UPSTREAM_UNAVAILABLE", error instanceof Error ? error.message : "OpenList upload failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
