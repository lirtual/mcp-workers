#!/usr/bin/env node
// Read-only IMA image export API comparison. Never prints note content, URLs or credentials.
// Usage: IMA_OPENAPI_CLIENTID=... IMA_OPENAPI_APIKEY=... node scripts/diagnose-image-export.mjs <note_id>
// Requires Node >= 20. No note writes and no Litterbox uploads.
import assert from "node:assert/strict";

const API = "https://ima.qq.com/";
const IMAGE_HOST = "ima-notebook-prod.image.myqcloud.com";
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

function countImages(input) {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return { parseable: false }; }
  }
  const seen = { parseable: true, total: 0, withMediaIdAndCosKey: 0, missingBoth: 0, legacyHostMissingBoth: 0 };
  function walk(v) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (v.type === "cloud_image") {
      seen.total++;
      const hasId = typeof v.mediaId === "string" && v.mediaId.length > 0;
      const hasKey = typeof v.cosKey === "string" && v.cosKey.length > 0;
      if (hasId && hasKey) seen.withMediaIdAndCosKey++;
      if (!hasId && !hasKey) {
        seen.missingBoth++;
        if (typeof v.url === "string") {
          try { if (new URL(v.url).hostname === IMAGE_HOST) seen.legacyHostMissingBoth++; } catch {}
        }
      }
    }
    for (const child of Object.values(v)) walk(child);
  }
  walk(value);
  return seen;
}

function errorSummary(error) {
  return { status: "failed", code: error.code ?? "transport_or_format_error" };
}

async function limitedText(res) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_CONTENT_BYTES) throw Object.assign(new Error("oversize"), { code: "oversize" });
  const reader = res.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONTENT_BYTES) throw Object.assign(new Error("oversize"), { code: "oversize" });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const item of chunks) { bytes.set(item, offset); offset += item.byteLength; }
  return new TextDecoder().decode(bytes);
}

function exportDownloadAllowed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password &&
      (host === "myqcloud.com" || host.endsWith(".myqcloud.com"));
  } catch { return false; }
}

async function post(apiPath, payload, credentials, transport) {
  const res = await transport(new URL(apiPath, API), {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(18000),
    headers: { "content-type": "application/json", "ima-openapi-clientid": credentials.clientId,
      "ima-openapi-apikey": credentials.apiKey, "ima-openapi-ctx": "plugin_version=0.5.0" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw Object.assign(new Error("HTTP status"), { code: res.status });
  const raw = await limitedText(res);
  let data;
  try { data = JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON"), { code: "invalid_json" }); }
  if (data.code !== 0) throw Object.assign(new Error("IMA error"), { code: data.code ?? "missing_code" });
  return data.data || {};
}

export async function diagnose(noteId, credentials, transport = fetch) {
  assert.match(noteId, /^[0-9]{8,30}$/);
  const output = { noteId, operations: {} };
  let baseline;
  try {
    const data = await post("openapi/note/v1/get_doc_content",
      { note_id: noteId, target_content_format: 2 }, credentials, transport);
    baseline = data.content;
    output.operations.get_doc_content = { status: "ok", ...countImages(baseline) };
  } catch (error) { output.operations.get_doc_content = errorSummary(error); }

  try {
    const data = await post("openapi/note/v1/export_note",
      { note_id: noteId, target_content_format: 2 }, credentials, transport);
    const raw = data.content;
    const url = data.content_url;
    if (raw !== undefined) {
      output.operations.export_note = { status: "ok", delivery: "inline", ...countImages(raw) };
    } else if (typeof url === "string") {
      if (!exportDownloadAllowed(url)) {
        output.operations.export_note = { status: "blocked", reason: "unrecognized_export_host", keys: Object.keys(data).sort() };
      } else {
        const res = await transport(new URL(url), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(18000) });
        if (!res.ok) throw Object.assign(new Error("download HTTP status"), { code: res.status });
        const downloaded = await limitedText(res);
        output.operations.export_note = { status: "ok", delivery: "content_url", ...countImages(downloaded) };
      }
    } else {
      output.operations.export_note = { status: "unknown_contract", keys: Object.keys(data).sort() };
    }
  } catch (error) { output.operations.export_note = errorSummary(error); }

  // Probe one known-good media ID; never expose or log its value / signed URL.
  let mediaId;
  try {
    const root = typeof baseline === "string" ? JSON.parse(baseline) : baseline;
    function find(v) {
      if (!v || typeof v !== "object" || mediaId) return;
      if (Array.isArray(v)) { for (const n of v) find(n); return; }
      if (v.type === "cloud_image" && typeof v.mediaId === "string" && v.mediaId) { mediaId = v.mediaId; return; }
      for (const n of Object.values(v)) find(n);
    }
    find(root);
  } catch {}
  if (!mediaId) output.operations.export_media_for_ima_sandbox = { status: "skipped_no_media_id" };
  else {
    try {
      const data = await post("openapi/wiki/v1/export_media_for_ima_sandbox",
        { media_id: mediaId }, credentials, transport);
      const url = data.url_info?.url || data.url;
      output.operations.export_media_for_ima_sandbox = {
        status: "ok", keys: Object.keys(data).sort(), urlPresent: typeof url === "string",
        urlTrustedHost: typeof url === "string" && exportDownloadAllowed(url),
      };
    } catch (error) { output.operations.export_media_for_ima_sandbox = errorSummary(error); }
  }
  return output;
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [noteId] = process.argv.slice(2);
  const credentials = {
    clientId: process.env.IMA_OPENAPI_CLIENTID || "",
    apiKey: process.env.IMA_OPENAPI_APIKEY || "",
  };
  if (!noteId || !credentials.clientId || !credentials.apiKey) {
    process.stderr.write("Usage: set IMA_OPENAPI_CLIENTID + IMA_OPENAPI_APIKEY; pass one note_id. No secrets are printed.\n");
    process.exitCode = 2;
  } else {
    diagnose(noteId, credentials).then((r) => process.stdout.write(JSON.stringify(r, null, 2) + "\n"))
      .catch((error) => { process.stderr.write("Diagnostic error: " + (error.code || "failed") + "\n"); process.exitCode = 1; });
  }
}
