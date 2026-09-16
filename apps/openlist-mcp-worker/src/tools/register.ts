import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppConfig } from "../types";
import { OpenListClient } from "../openlist/client";
import { AppError } from "../mcp/errors";
import { fail, ok } from "../mcp/responses";
import { assertName, assertPathAllowed, normalizeOpenListPath } from "../policy/paths";

const TASK_TYPES = ["upload", "copy", "offline_download", "offline_download_transfer", "decompress", "decompress_upload"] as const;
const TASK_STATUS = ["done", "undone"] as const;

function normalizeNames(names: string[]): string[] {
  const normalized = names.map(assertName);
  if (normalized.length === 0) throw new AppError("INVALID_ARGUMENT", "At least one name is required");
  return normalized;
}

function decodeBase64(input: string): Uint8Array {
  try {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new AppError("INVALID_ARGUMENT", "file_content_base64 is not valid base64");
  }
}

function destinationAfterRename(path: string, name: string): string {
  const normalized = normalizeOpenListPath(path);
  const parent = normalized === "/" ? "/" : normalized.slice(0, normalized.lastIndexOf("/")) || "/";
  return `${parent === "/" ? "" : parent}/${assertName(name)}` || "/";
}

export function registerTools(server: McpServer, config: AppConfig, client: OpenListClient): void {
  server.registerTool("get_capabilities", { description: "Return the bounded capabilities and safety policy of this OpenList MCP Worker.", inputSchema: {} }, async () => ok({ server: "openlist-mcp-worker", version: "0.1.0", readonly: config.readonly, allowed_paths: config.allowedPaths.map(normalizeOpenListPath), upload_max_bytes: config.uploadMaxBytes, features: { filesystem_read: true, filesystem_write: !config.readonly, search: true, small_file_upload: !config.readonly, task_read: true, task_write: !config.readonly, large_file_proxy: false, recursive_smart_tools: false } }));

  server.registerTool("list_files", { description: "List files and folders in an allowed OpenList directory.", inputSchema: { path: z.string().default("/"), page: z.number().int().min(1).default(1), per_page: z.number().int().min(1).max(200).default(50), refresh: z.boolean().default(false), password: z.string().default("") } }, async ({ path, page, per_page, refresh, password }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); return ok(await client.request("POST", "fs/list", { body: { path: safe, page, per_page, refresh, password } })); } catch (e) { return fail(e); } });

  server.registerTool("list_dirs", { description: "List child directories under an allowed OpenList path.", inputSchema: { path: z.string().default("/"), password: z.string().default(""), force_root: z.boolean().default(false) } }, async ({ path, password, force_root }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); return ok(await client.request("POST", "fs/dirs", { body: { path: safe, password, force_root } })); } catch (e) { return fail(e); } });

  server.registerTool("get_file_info", { description: "Get metadata for a file or directory in an allowed OpenList path.", inputSchema: { path: z.string(), password: z.string().default("") } }, async ({ path, password }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); const data = await client.request<Record<string, unknown>>("POST", "fs/get", { body: { path: safe, password } }); if (data && typeof data === "object" && "raw_url" in data) { const { raw_url: _rawUrl, ...safeData } = data; return ok(safeData); } return ok(data); } catch (e) { return fail(e); } });

  server.registerTool("search_files", { description: "Search OpenList's search index within an allowed parent path. Does not recursively crawl as a fallback.", inputSchema: { parent: z.string().default("/"), keywords: z.string().min(1), scope: z.number().int().min(0).max(2).default(0), page: z.number().int().min(1).default(1), per_page: z.number().int().min(1).max(200).default(50), password: z.string().default("") } }, async ({ parent, keywords, scope, page, per_page, password }) => { try { const safe = assertPathAllowed(parent, config.allowedPaths); return ok(await client.request("POST", "fs/search", { body: { parent: safe, keywords, scope, page, per_page, password } })); } catch (e) { return fail(e); } });

  server.registerTool("get_download_url", { description: "Return OpenList's download URL for a file. The Worker does not proxy file content.", inputSchema: { path: z.string(), password: z.string().default("") } }, async ({ path, password }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); const data = await client.request<Record<string, unknown>>("POST", "fs/get", { body: { path: safe, password } }); const rawUrl = typeof data?.raw_url === "string" ? data.raw_url : undefined; if (!rawUrl) throw new AppError("NOT_FOUND", "OpenList did not return a download URL for this path"); return ok({ path: safe, download_url: rawUrl }); } catch (e) { return fail(e); } });

  server.registerTool("list_tasks", { description: "List OpenList background tasks by type and status.", inputSchema: { task_type: z.enum(TASK_TYPES).default("offline_download"), status: z.enum(TASK_STATUS).default("undone"), page: z.number().int().min(1).default(1), per_page: z.number().int().min(1).max(200).default(50) } }, async ({ task_type, status, page, per_page }) => { try { return ok(await client.request("GET", `task/${task_type}/${status}`, { query: { page, per_page } })); } catch (e) { return fail(e); } });

  server.registerTool("get_task_info", { description: "Get one OpenList background task by ID.", inputSchema: { task_id: z.string().min(1), task_type: z.enum(TASK_TYPES).default("offline_download") } }, async ({ task_id, task_type }) => { try { return ok(await client.request("POST", `task/${task_type}/info`, { query: { tid: task_id.trim() } })); } catch (e) { return fail(e); } });

  if (config.readonly) return;

  server.registerTool("create_folder", { description: "Create a directory under an allowed OpenList path.", inputSchema: { path: z.string() } }, async ({ path }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); await client.request("POST", "fs/mkdir", { body: { path: safe } }); return ok({ created: safe }); } catch (e) { return fail(e); } });

  server.registerTool("rename", { description: "Rename a file or folder without moving it outside its current parent directory.", inputSchema: { path: z.string(), name: z.string() } }, async ({ path, name }) => { try { const safe = assertPathAllowed(path, config.allowedPaths); const safeName = assertName(name); assertPathAllowed(destinationAfterRename(safe, safeName), config.allowedPaths); await client.request("POST", "fs/rename", { body: { path: safe, name: safeName } }); return ok({ renamed: safe, name: safeName }); } catch (e) { return fail(e); } });

  server.registerTool("copy", { description: "Copy named files/folders from one allowed directory to another allowed directory.", inputSchema: { src_dir: z.string(), dst_dir: z.string(), names: z.array(z.string()).min(1) } }, async ({ src_dir, dst_dir, names }) => { try { const src = assertPathAllowed(src_dir, config.allowedPaths); const dst = assertPathAllowed(dst_dir, config.allowedPaths); const safeNames = normalizeNames(names); const data = await client.request("POST", "fs/copy", { body: { src_dir: src, dst_dir: dst, names: safeNames } }); return ok({ source: src, destination: dst, names: safeNames, result: data }); } catch (e) { return fail(e); } });

  server.registerTool("move", { description: "Move named files/folders from one allowed directory to another allowed directory.", inputSchema: { src_dir: z.string(), dst_dir: z.string(), names: z.array(z.string()).min(1) } }, async ({ src_dir, dst_dir, names }) => { try { const src = assertPathAllowed(src_dir, config.allowedPaths); const dst = assertPathAllowed(dst_dir, config.allowedPaths); const safeNames = normalizeNames(names); const data = await client.request("POST", "fs/move", { body: { src_dir: src, dst_dir: dst, names: safeNames } }); return ok({ source: src, destination: dst, names: safeNames, result: data }); } catch (e) { return fail(e); } });

  server.registerTool("remove", { description: "Delete named files/folders from an allowed directory. Requires confirm=true.", inputSchema: { directory: z.string(), names: z.array(z.string()).min(1), confirm: z.boolean().default(false) } }, async ({ directory, names, confirm }) => { try { if (!confirm) throw new AppError("INVALID_ARGUMENT", "Deletion requires confirm=true"); const dir = assertPathAllowed(directory, config.allowedPaths); const safeNames = normalizeNames(names); await client.request("POST", "fs/remove", { body: { dir, names: safeNames } }); return ok({ deleted_from: dir, names: safeNames }); } catch (e) { return fail(e); } });

  server.registerTool("upload_file", { description: "Upload a small base64-encoded file to an allowed directory. Large-file upload is intentionally unsupported.", inputSchema: { path: z.string(), file_name: z.string(), file_content_base64: z.string().min(1) } }, async ({ path, file_name, file_content_base64 }) => { try { const dir = assertPathAllowed(path, config.allowedPaths); const name = assertName(file_name); const estimatedBytes = Math.floor(file_content_base64.length * 3 / 4); if (estimatedBytes > config.uploadMaxBytes) throw new AppError("PAYLOAD_TOO_LARGE", `Decoded upload exceeds ${config.uploadMaxBytes} bytes`); const bytes = decodeBase64(file_content_base64); if (bytes.byteLength > config.uploadMaxBytes) throw new AppError("PAYLOAD_TOO_LARGE", `Decoded upload exceeds ${config.uploadMaxBytes} bytes`); const result = await client.upload(dir, name, bytes); return ok({ path: dir, file_name: name, bytes: bytes.byteLength, result }); } catch (e) { return fail(e); } });

  server.registerTool("retry_task", { description: "Retry a failed OpenList background task.", inputSchema: { task_id: z.string().min(1), task_type: z.enum(TASK_TYPES).default("offline_download") } }, async ({ task_id, task_type }) => { try { await client.request("POST", `task/${task_type}/retry`, { query: { tid: task_id.trim() } }); return ok({ retried: task_id, task_type }); } catch (e) { return fail(e); } });

  server.registerTool("cancel_task", { description: "Cancel a running OpenList background task. Requires confirm=true.", inputSchema: { task_id: z.string().min(1), task_type: z.enum(TASK_TYPES).default("offline_download"), confirm: z.boolean().default(false) } }, async ({ task_id, task_type, confirm }) => { try { if (!confirm) throw new AppError("INVALID_ARGUMENT", "Task cancellation requires confirm=true"); await client.request("POST", `task/${task_type}/cancel`, { query: { tid: task_id.trim() } }); return ok({ cancelled: task_id, task_type }); } catch (e) { return fail(e); } });

  server.registerTool("delete_task", { description: "Delete an OpenList task record. Requires confirm=true.", inputSchema: { task_id: z.string().min(1), task_type: z.enum(TASK_TYPES).default("offline_download"), confirm: z.boolean().default(false) } }, async ({ task_id, task_type, confirm }) => { try { if (!confirm) throw new AppError("INVALID_ARGUMENT", "Task deletion requires confirm=true"); await client.request("POST", `task/${task_type}/delete`, { query: { tid: task_id.trim() } }); return ok({ deleted_task: task_id, task_type }); } catch (e) { return fail(e); } });
}
