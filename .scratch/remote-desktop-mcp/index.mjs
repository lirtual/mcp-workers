// THROWAWAY prototype for #173: deliberately NOT a deployable production MCP server.
// Requires three independent secrets; no oauth or unrestricted local tools.
import { DurableObject } from "cloudflare:workers";
import { RelayState } from "./relay-state.mjs";

const LIMIT = 8192;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });

async function authorized(request, expected) {
  if (!expected || expected.length < 24) return false;
  const value = request.headers.get("authorization") || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (supplied.length !== expected.length) return false;
  // A digest comparison avoids content-dependent early exits.
  const digest = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function body(request) {
  // Never buffer a whole untrusted HTTP request before enforcing its limit.
  // Content-Length is an early rejection only; a streaming count is required
  // because chunked bodies and incorrect Content-Length values are possible.
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\\d+$/.test(declared) && Number(declared) > LIMIT) {
    throw new Error("payload_too_large");
  }
  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMIT) {
        await reader.cancel("payload_too_large");
        throw new Error("payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class PrototypeDevice extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.relay = new RelayState();
    this.ready = ctx.storage.get("revoked").then((revoked) => {
      if (revoked) this.relay.revoked = true;
      const active = ctx.getWebSockets();
      if (!revoked && active.length === 1) {
        this.relay.restore(active[0], active[0].deserializeAttachment()?.generation);
      }
    });
  }

  async fetch(request) {
    await this.ready;
    const path = new URL(request.url).pathname;
    if (path === "/device") {
      if (this.relay.revoked) return json({ error: "revoked" }, 403);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const generation = crypto.randomUUID();
      if (!this.relay.connect(server, generation)) return json({ error: "revoked" }, 403);
      server.serializeAttachment({ generation });
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/revoke" && request.method === "POST") {
      // Persistent server-side revocation precedes dispatch cancellation.
      await this.ctx.storage.put("revoked", true);
      this.relay.revoke();
      return json({ revoked: true });
    }
    if (path === "/invoke" && request.method === "POST") {
      let call;
      try { call = await body(request); } catch { return json({ error: "bad_request" }, 400); }
      if (typeof call.id !== "string" || call.id.length > 128 ||
          !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
        return json({ error: "invalid_call" }, 400);
      }
      if (call.tool === "sandbox_ping") {
        if (typeof call.arguments.echo !== "string" || call.arguments.echo.length > 64 ||
            Object.keys(call.arguments).some((key) => key !== "echo")) {
          return json({ error: "invalid_call" }, 400);
        }
      } else if (call.tool === "sandbox_list_directory") {
        // No remotely chosen path: local bridge holds the only sandbox path.
        if (Object.keys(call.arguments).length !== 0) return json({ error: "invalid_call" }, 400);
      } else {
        return json({ error: "invalid_call" }, 400);
      }
      try {
        // External stdio launch within isolated CI has bounded startup cost.
        // Keep the synthetic ping timeout short for offline/error tests.
        const deadline = call.tool === "sandbox_list_directory" ? 25000 : 1500;
        const result = await this.relay.invoke(call.id, call.tool, call.arguments, deadline);
        return json({ result });
      } catch (e) {
        const reason = e.message;
        return json({ error: reason }, reason === "revoked" ? 403 : 503);
      }
    }
    return json({ error: "not_found" }, 404);
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > LIMIT) {
      ws.close(1009, "payload_too_large");
      this.relay.disconnect(ws);
      return;
    }
    let data;
    try { data = JSON.parse(message); } catch { ws.close(1007, "invalid_json"); return; }
    if (data?.type !== "result" || typeof data.id !== "string" ||
        typeof data.result !== "object" || data.result === null) return;
    this.relay.result(ws, data);
  }

  async webSocketClose(ws) {
    this.relay.disconnect(ws);
  }

  async webSocketError(ws) {
    this.relay.disconnect(ws);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const configured = [env.PROTOTYPE_MCP_TOKEN, env.PROTOTYPE_DEVICE_TOKEN, env.PROTOTYPE_ADMIN_TOKEN]
      .every((token) => typeof token === "string" && token.length >= 24);
    if (!configured) return json({ error: "prototype_not_configured" }, 503);
    if (path === "/device") {
      if (!(await authorized(request, env.PROTOTYPE_DEVICE_TOKEN))) return json({ error: "unauthorized" }, 401);
      const stub = env.DEVICE.get(env.DEVICE.idFromName("scratch-only"));
      return stub.fetch(new Request("https://internal/device", { headers: { upgrade: request.headers.get("upgrade") || "" } }));
    }
    if (path === "/admin/revoke" && request.method === "POST") {
      if (!(await authorized(request, env.PROTOTYPE_ADMIN_TOKEN))) return json({ error: "unauthorized" }, 401);
      return env.DEVICE.get(env.DEVICE.idFromName("scratch-only"))
        .fetch(new Request("https://internal/revoke", { method: "POST" }));
    }
    if (path !== "/mcp") return json({ error: "not_found" }, 404);
    if (!(await authorized(request, env.PROTOTYPE_MCP_TOKEN))) return json({ error: "unauthorized" }, 401);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let msg;
    try { msg = await body(request); } catch { return json({ error: "invalid_json_or_payload" }, 400); }
    if (!msg || msg.jsonrpc !== "2.0" || Array.isArray(msg)) return json(error(null, -32600, "Invalid Request"));
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    const id = msg.id ?? null;
    if (id === null || (typeof id !== "string" && typeof id !== "number")) return json(error(null, -32600, "Invalid Request"));
    if (msg.method === "initialize") {
      return json(reply(id, { protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "throwaway-remote-desktop-prototype", version: "0.0.0" } }));
    }
    if (msg.method === "ping") return json(reply(id, {}));
    if (msg.method === "tools/list") {
      return json(reply(id, { tools: [{ name: "sandbox_ping",
        description: "Harmless synthetic device reachability test; no filesystem or shell access.",
        inputSchema: { type: "object", properties: { echo: { type: "string", maxLength: 64 } },
          required: ["echo"], additionalProperties: false } },
        { name: "sandbox_list_directory",
          description: "Read-only listing of the bridge's predefined test directory; caller cannot choose a path.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return json(error(id, -32602, "Invalid params"));
      }
      if (name === "sandbox_ping") {
        if (typeof args.echo !== "string" || args.echo.length > 64 ||
            Object.keys(args).some((key) => key !== "echo")) return json(error(id, -32602, "Invalid params"));
      } else if (name === "sandbox_list_directory") {
        if (Object.keys(args).length !== 0) return json(error(id, -32602, "Invalid params"));
      } else return json(error(id, -32602, "Invalid params"));
      const stub = env.DEVICE.get(env.DEVICE.idFromName("scratch-only"));
      const result = await stub.fetch(new Request("https://internal/invoke", {
        method: "POST",
        body: JSON.stringify({ id: crypto.randomUUID(), tool: name, arguments: args }),
      }));
      const data = await result.json();
      if (!result.ok) return json(error(id, -32000, data.error || "offline"));
      return json(reply(id, { content: [{ type: "text", text: JSON.stringify(data.result) }] }));
    }
    return json(error(id, -32601, "Method not found"));
  },
};
