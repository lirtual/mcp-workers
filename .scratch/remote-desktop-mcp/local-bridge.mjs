// THROWAWAY local read-only bridge for #173. Not the Desktop Commander executor.
// Only connects to WSS, or WS on loopback in a test. No terminal, arbitrary path or write tools.
import WebSocket from "ws";
import { readdir, realpath } from "node:fs/promises";
const MAX_ENTRIES = 64;
const MAX_MESSAGE_BYTES = 8192;

function endpointAllowed(endpoint) {
  const url = new URL(endpoint);
  return url.protocol === "wss:" ||
    (url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
}

export async function connectSandboxBridge({ endpoint, token, sandboxRoot, directoryReader = null }) {
  if (!endpointAllowed(endpoint)) throw new Error("secure_websocket_required");
  if (typeof token !== "string" || token.length < 24) throw new Error("missing_device_token");
  // Canonicalize once; the MCP request never accepts a path or a command.
  const root = await realpath(sandboxRoot);
  const socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${token}` },
    maxPayload: MAX_MESSAGE_BYTES });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) => reject(new Error(`connect_rejected_${res.statusCode}`)));
  });
  socket.on("message", async (raw) => {
    let call;
    try { call = JSON.parse(raw.toString()); } catch { socket.close(1007, "invalid_json"); return; }
    if (call?.type !== "call" || typeof call.id !== "string" || call.id.length > 128) return;
    let result;
    if (call.tool === "sandbox_ping" &&
        typeof call.arguments?.echo === "string" && call.arguments.echo.length <= 64 &&
        Object.keys(call.arguments).length === 1) {
      result = { echo: call.arguments.echo };
    } else if (call.tool === "sandbox_list_directory" && call.arguments &&
               typeof call.arguments === "object" && !Array.isArray(call.arguments) &&
               Object.keys(call.arguments).length === 0) {
      try {
        if (directoryReader) {
          // Caller-supplied path is NEVER passed to the executor: root is
          // canonicalized once at bridge startup and arguments must be {}.
          result = await directoryReader(root);
        } else {
          const entries = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => !entry.isSymbolicLink())
            .map((entry) => entry.name)
            .sort()
            .slice(0, MAX_ENTRIES);
          result = { entries };
        }
      } catch {
        result = { error: "sandbox_unavailable" };
      }
    } else {
      // This bridge intentionally does not relay desktop-commander's privileged tools.
      result = { error: "tool_or_arguments_denied" };
    }
    const serialized = JSON.stringify({ type: "result", id: call.id, result });
    if (Buffer.byteLength(serialized, "utf8") <= MAX_MESSAGE_BYTES && socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.close(1009, "result_too_large");
    }
  });
  return socket;
}
