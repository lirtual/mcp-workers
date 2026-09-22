// THROWAWAY #178. Loopback-only device adapter. NOT a production security boundary.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readViaIsolatedDesktopCommander } from "../remote-desktop-mcp/isolated-upstream.mjs";

const MAX_REQUEST_BYTES = 8192;
const MAX_RESULT_BYTES = 8192;

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function sameSecret(given, expected) {
  const a = Buffer.from(given || ""), b = Buffer.from(expected || "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "arguments,tool" ||
      !["sandbox_ping", "sandbox_list_directory"].includes(body.tool) ||
      !body.arguments || typeof body.arguments !== "object" ||
      Array.isArray(body.arguments) || Object.keys(body.arguments).length) {
    throw new Error("forbidden_request");
  }
}
async function receive(req) {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new Error("request_too_large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_json"); }
}
export function createAdapter({ token, fixedRoot, execute = readViaIsolatedDesktopCommander,
  timeoutMs = 25000 } = {}) {
  if (typeof token !== "string" || token.length < 24 || typeof fixedRoot !== "string" || !fixedRoot) {
    throw new Error("adapter_configuration_missing");
  }
  return createServer(async (req, res) => {
    if (req.url !== "/invoke" || req.method !== "POST") return json(res, 404, { error: "not_found" });
    if (!sameSecret(req.headers.authorization, "Bearer " + token)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      return json(res, 415, { error: "unsupported_media_type" });
    }
    try {
      const body = await receive(req);
      validate(body);
      let result;
      if (body.tool === "sandbox_ping") {
        result = { source: "restricted-adapter", text: "pong" };
      } else {
        let deadline;
        try {
          result = await Promise.race([
            execute(fixedRoot),
            new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error("upstream_timeout")), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      }
      const encoded = JSON.stringify({ tool: body.tool, result });
      if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) throw new Error("result_too_large");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(encoded);
    } catch (err) {
      const code = err?.message;
      const status = code === "request_too_large" ? 413
        : code === "invalid_json" || code === "forbidden_request" ? 400
        : code === "upstream_timeout" ? 504
        : code === "result_too_large" ? 502 : 503;
      json(res, status, { error: ["request_too_large", "invalid_json", "forbidden_request",
        "upstream_timeout", "result_too_large"].includes(code) ? code : "upstream_unavailable" });
    }
  });
}
