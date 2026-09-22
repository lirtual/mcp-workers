// THROWAWAY #178. NOT a remote MCP server or OAuth implementation.
// Use only with a separate disabled-by-default prototype Worker and a real VPC Service.
const MAX_BYTES = 8192;
function reply(status, error) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
async function boundedBody(request) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    throw new Error("request_too_large");
  }
  const parts = [];
  let total = 0;
  for await (const part of request.body || []) {
    total += part.byteLength;
    if (total > MAX_BYTES) throw new Error("request_too_large");
    parts.push(part);
  }
  const buffer = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { buffer.set(part, pos); pos += part.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  try { return JSON.parse(text); } catch { throw new Error("invalid_json"); }
}
function valid(body) {
  return body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).sort().join(",") === "arguments,tool" &&
    ["sandbox_ping", "sandbox_list_directory"].includes(body.tool) &&
    body.arguments && typeof body.arguments === "object" &&
    !Array.isArray(body.arguments) && Object.keys(body.arguments).length === 0;
}
export default {
  async fetch(request, env) {
    const origin = env.PROTOTYPE_ALLOWED_ORIGIN;
    if (!origin || !/^https:\/\//.test(origin) ||
        request.url !== origin + "/_probe/invoke") return reply(404, "not_found");
    if (!env.PROTOTYPE_CLIENT_TOKEN || env.PROTOTYPE_CLIENT_TOKEN.length < 24 ||
        !env.PROTOTYPE_ADAPTER_TOKEN || env.PROTOTYPE_ADAPTER_TOKEN.length < 24 ||
        typeof env.PRIVATE_DEVICE?.fetch !== "function") return reply(503, "not_configured");
    if (request.method !== "POST" ||
        request.headers.get("authorization") !== "Bearer " + env.PROTOTYPE_CLIENT_TOKEN) {
      return reply(401, "unauthorized");
    }
    const suppliedOrigin = request.headers.get("origin");
    if (suppliedOrigin && suppliedOrigin !== origin) return reply(403, "origin_denied");
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      return reply(415, "unsupported_media_type");
    }
    let body;
    try { body = await boundedBody(request); }
    catch (e) { return reply(e.message === "request_too_large" ? 413 : 400,
      e.message === "request_too_large" ? "request_too_large" : "invalid_json"); }
    if (!valid(body)) return reply(400, "forbidden_request");
    try {
      // Host/port are determined by the registered VPC Service, NOT by this URL.
      const response = await env.PRIVATE_DEVICE.fetch("http://localhost/invoke", {
        method: "POST",
        headers: { "content-type": "application/json",
          "authorization": "Bearer " + env.PROTOTYPE_ADAPTER_TOKEN },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(26000),
      });
      const announced = response.headers.get("content-length");
      if (announced !== null && /^\d+$/.test(announced) && Number(announced) > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        return reply(502, "upstream_result_too_large");
      }
      const chunks = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES) {
            await reader.cancel().catch(() => {});
            return reply(502, "upstream_result_too_large");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      return new Response(bytes, { status: response.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch {
      // Never return the private service host, tunnel errors, or credentials.
      return reply(503, "private_device_unavailable");
    }
  },
};
