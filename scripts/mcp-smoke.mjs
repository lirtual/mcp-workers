#!/usr/bin/env node

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const DEFAULT_TOKEN_ENV = "MCP_ACCESS_TOKEN";
const TIMEOUT_MS = 30_000;

const HELP = `Usage:
  pnpm smoke:mcp -- --url <mcp-url> --tool <explicit-safe-tool> [options]

Required:
  --url <url>           Streamable HTTP MCP endpoint.
  --tool <name>         One explicitly selected safe/read-only tool to call.

Options:
  --args-json <json>    JSON object passed as tool arguments. Default: {}.
  --token-env <name>    Environment variable holding the bearer token.
                        Default: ${DEFAULT_TOKEN_ENV}.
  --help                Show this help.

The bearer token is accepted only through an environment variable. This runner
never chooses tools from readOnlyHint or other annotations; the caller must
name the exact safe tool to invoke. Tool result bodies are not printed.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const parsed = {
    url: undefined,
    tool: undefined,
    argsJson: "{}",
    tokenEnv: DEFAULT_TOKEN_ENV,
    help: false,
  };

  const valueOptions = new Map([
    ["--url", "url"],
    ["--tool", "tool"],
    ["--args-json", "argsJson"],
    ["--token-env", "tokenEnv"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    const key = valueOptions.get(arg);
    if (!key) {
      throw new UsageError(`Unknown option: ${arg}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`${arg} requires a value.`);
    }
    parsed[key] = value;
    index += 1;
  }

  if (parsed.help) return parsed;
  if (!parsed.url) throw new UsageError("--url is required.");
  if (!parsed.tool) throw new UsageError("--tool is required.");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.tokenEnv)) {
    throw new UsageError("--token-env must be a valid environment variable name.");
  }

  let url;
  try {
    url = new URL(parsed.url);
  } catch {
    throw new UsageError("--url must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError("--url must use http or https.");
  }

  let toolArguments;
  try {
    toolArguments = JSON.parse(parsed.argsJson);
  } catch {
    throw new UsageError("--args-json must be valid JSON.");
  }
  if (
    toolArguments === null ||
    typeof toolArguments !== "object" ||
    Array.isArray(toolArguments)
  ) {
    throw new UsageError("--args-json must decode to a JSON object.");
  }

  return {
    ...parsed,
    url,
    toolArguments,
  };
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeClient(client, transport) {
  try {
    await transport.terminateSession();
  } catch {
    // Session termination is best-effort; closing the client is still required.
  }
  try {
    await client.close();
  } catch {
    // Preserve the primary smoke result/error rather than failing during cleanup.
  }
}

async function runSmoke(options) {
  const token = process.env[options.tokenEnv];
  if (!token?.trim()) {
    throw new UsageError(
      `Environment variable ${options.tokenEnv} is not set or empty.`,
    );
  }

  const client = new Client(
    { name: "mcp-workers-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(options.url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  try {
    await withTimeout(client.connect(transport), "MCP connect");

    const { tools } = await withTimeout(client.listTools(), "tools/list");
    const target = tools.find((tool) => tool.name === options.tool);
    if (!target) {
      throw new Error(
        `Explicit smoke tool '${options.tool}' was not found in tools/list.`,
      );
    }

    const result = await withTimeout(
      client.callTool({
        name: options.tool,
        arguments: options.toolArguments,
      }),
      `tools/call ${options.tool}`,
    );

    if (result.isError) {
      throw new Error(`Tool '${options.tool}' returned isError=true.`);
    }

    const era = client.getProtocolEra?.() ?? "unknown";
    console.log(
      `MCP smoke passed: tool=${options.tool} discovered=${tools.length} era=${era}`,
    );
  } finally {
    await closeClient(client, transport);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Usage error: ${error.message}`);
      console.error("Run with --help for usage.");
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  try {
    await runSmoke(options);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Usage error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MCP smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

await main();
