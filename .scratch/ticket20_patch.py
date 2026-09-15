from pathlib import Path
import json
import re

ROOT = Path("apps/raindrop-mcp-worker")

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

service_path = ROOT / "src/services/raindrop.service.ts"
text = service_path.read_text()

text = replace_once(text, 'import Keyv from "keyv";\n', '', "remove keyv import")
text = replace_once(
    text,
    'import { RateLimiterMemory } from "rate-limiter-flexible";\n',
    '',
    "remove rate limiter import",
)

type_anchor = '''type HighlightColor = NonNullable<Highlight["color"]>;
'''
type_replacement = '''type HighlightColor = NonNullable<Highlight["color"]>;

export interface RaindropServiceConfig {
  accessToken?: string;
  maxReadRetries?: number;
  debugHttp?: boolean;
}
'''
text = replace_once(text, type_anchor, type_replacement, "add service config type")

fields_old = '''  private client;
  private rateLimiter?: RateLimiterMemory;
  private logger = createLogger("raindrop-service");

  // Caches for different data types
  private cacheCollections: Keyv;
  private cacheBookmarks: Keyv;
  private cacheSearch: Keyv;
  private readonly maxRateLimitRetries: number;

  constructor(token?: string) {
    this.client = createClient<paths>({
      baseUrl: "https://api.raindrop.io/rest/v1",
      headers: {
        Authorization: `Bearer ${token || process.env.RAINDROP_ACCESS_TOKEN}`,
      },
    });

    // Initialize caches
    this.cacheCollections = new Keyv();
    this.cacheBookmarks = new Keyv();
    this.cacheSearch = new Keyv();

    // Conservative rate limiting: 30 points per 60 seconds (2 requests/second max)
    // Provides buffer for Raindrop.io's rate limits and reduces spikes
    const points = Number(process.env.RAINDROP_RATE_LIMIT_POINTS || 30);
    const duration = Number(
      process.env.RAINDROP_RATE_LIMIT_DURATION_SECONDS || 60,
    );
    this.rateLimiter = new RateLimiterMemory({
      points,
      duration,
      keyPrefix: "raindrop",
    });
    this.maxRateLimitRetries = Number(
      process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES || 3,
    );

    this.client.use({
      onRequest({ request }) {
        if (process.env.NODE_ENV === "development") {
'''
fields_new = '''  private client;
  private logger = createLogger("raindrop-service");

  // These caches are intentionally request/service-instance scoped. The Worker
  // creates a fresh service for each stateless MCP request, so TTL-based cache
  // semantics would falsely imply cross-request persistence.
  private cacheCollections = new Map<string, unknown>();
  private cacheBookmarks = new Map<string, unknown>();
  private cacheSearch = new Map<string, unknown>();
  private readonly maxRateLimitRetries: number;

  constructor(config: string | RaindropServiceConfig = {}) {
    const normalized: RaindropServiceConfig =
      typeof config === "string" ? { accessToken: config } : config;
    const maxReadRetries = normalized.maxReadRetries;
    this.maxRateLimitRetries =
      maxReadRetries !== undefined &&
      Number.isInteger(maxReadRetries) &&
      maxReadRetries >= 0
        ? maxReadRetries
        : 3;
    const accessToken = normalized.accessToken ?? "";
    const debugHttp = normalized.debugHttp ?? false;

    this.client = createClient<paths>({
      baseUrl: "https://api.raindrop.io/rest/v1",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    this.client.use({
      onRequest({ request }) {
        if (debugHttp) {
'''
text = replace_once(text, fields_old, fields_new, "replace service lifecycle/config block")

text = replace_once(
    text,
    '''      if (this.rateLimiter) {
        await this.rateLimiter.consume("global");
      }
      return await fn();
''',
    '''      return await fn();
''',
    "remove local limiter consume",
)

local_rejection_pattern = re.compile(
    r'''\n      // Local limiter rejection happens before the upstream call, so it is safe\n      // to wait and retry even for writes: no mutation has been submitted yet\.\n      if \(err\?\.msBeforeNext !== undefined\) \{.*?\n      \}\n\n      // Once a write has reached the upstream request, never resubmit it\n''',
    re.S,
)
text, n = local_rejection_pattern.subn(
    '\n      // Once a write has reached the upstream request, never resubmit it\n',
    text,
    count=1,
)
if n != 1:
    raise SystemExit(f"remove local limiter rejection block: {n}")

cache_replacements = [
    (
        '    await this.cacheCollections.set("all", collections, 3600000); // 1 hour TTL\n',
        '    this.cacheCollections.set("all", collections);\n',
        "collections cache set",
    ),
    (
        '    await this.cacheCollections.set(`id:${id}`, collection, 3600000);\n',
        '    this.cacheCollections.set(`id:${id}`, collection);\n',
        "collection cache set",
    ),
    (
        '''    await this.cacheCollections.set(
      `children:${parentId}`,
      collections,
      3600000,
    );
''',
        '''    this.cacheCollections.set(`children:${parentId}`, collections);
''',
        "child collections cache set",
    ),
    (
        '    await this.cacheSearch.set(cacheKey, result, 300000); // 5 minute TTL\n',
        '    this.cacheSearch.set(cacheKey, result);\n',
        "search cache set",
    ),
    (
        '    await this.cacheBookmarks.set(`id:${id}`, bookmark, 900000); // 15 minute TTL\n',
        '    this.cacheBookmarks.set(`id:${id}`, bookmark);\n',
        "bookmark cache set",
    ),
]
for old, new, label in cache_replacements:
    text = replace_once(text, old, new, label)

if "process.env" in text:
    raise SystemExit("raindrop.service.ts still reads process.env")
if "RateLimiterMemory" in text or "new Keyv" in text:
    raise SystemExit("raindrop.service.ts still contains removed lifecycle mechanisms")
service_path.write_text(text)

mcp_path = ROOT / "src/services/raindropmcp.service.ts"
text = mcp_path.read_text()

text = replace_once(
    text,
    'import RaindropService from "./raindrop.service.js";\n',
    'import RaindropService, { type RaindropServiceConfig } from "./raindrop.service.js";\n',
    "import service config type",
)
text = replace_once(
    text,
    '  private resourceSubscriptions: Set<string> = new Set(); // Track resource subscriptions\n',
    '',
    "remove subscription state",
)

manifest_old = '''  /**
   * Returns the MCP manifest and server capabilities for host integration and debugging.
   * Uses the SDK's getManifest() method if available, otherwise builds a manifest from registered tools/resources.
   */
  public async getManifest(): Promise<unknown> {
    if (typeof (this.server as any).getManifest === "function") {
      return (this.server as any).getManifest();
    }
    // Fallback: build manifest manually
    return {
      name: "raindrop-mcp",
      version: SERVER_VERSION,
      description:
        "MCP Server for Raindrop.io with advanced interactive capabilities",
      capabilities: (this.server as any).capabilities,
      tools: await this.listTools(),
      // Optionally add resources, schemas, etc.
    };
  }

  constructor() {
    try {
      this.raindropService = new RaindropService();
'''
manifest_new = '''  /**
   * Returns app-owned metadata for host integration and debugging without
   * reaching into MCP SDK private fields.
   */
  public async getManifest(): Promise<unknown> {
    return {
      name: "raindrop-mcp",
      version: SERVER_VERSION,
      description:
        "MCP Server for Raindrop.io with advanced interactive capabilities",
      capabilities: {
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        tools: { listChanged: false },
      },
      tools: await this.listTools(),
      resources: this.listResources(),
      prompts: this.prompts.map(({ name, description }) => ({
        name,
        description,
      })),
    };
  }

  constructor(config: RaindropServiceConfig = {}) {
    try {
      this.raindropService = new RaindropService(config);
'''
text = replace_once(text, manifest_old, manifest_new, "replace manifest/constructor config")

text = replace_once(
    text,
    '''          capabilities: {
            resources: { subscribe: true, listChanged: true },
            prompts: { listChanged: true },
            tools: { listChanged: true },
''',
    '''          capabilities: {
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
            tools: { listChanged: false },
''',
    "truthful list/subscription capabilities",
)

subscribe_pattern = re.compile(
    r'''\n    // Add resource subscription handlers for protocol 2025-11-25\n    this\.server\.server\.setRequestHandler\(\n      "resources/subscribe",.*?\n    \);\n\n    this\.server\.server\.setRequestHandler\(\n      "resources/unsubscribe",.*?\n    \);\n''',
    re.S,
)
text, n = subscribe_pattern.subn('\n', text, count=1)
if n != 1:
    raise SystemExit(f"remove subscription handlers: {n}")

list_tools_pattern = re.compile(
    r'''  public async listTools\(\): Promise<\n    Array<\{\n      id: string;\n      name: string;\n      description: string;\n      inputSchema: unknown;\n      outputSchema: unknown;\n    \}>\n  > \{.*?\n  \}\n\n  /\*\*\n   \* Call a registered tool''',
    re.S,
)
list_tools_new = '''  public async listTools(): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      inputSchema: unknown;
      outputSchema: unknown;
    }>
  > {
    return toolConfigs.map((config) => ({
      id: config.name,
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema || {},
    }));
  }

  /**
   * Call a registered tool'''
text, n = list_tools_pattern.subn(list_tools_new, text, count=1)
if n != 1:
    raise SystemExit(f"replace listTools: {n}")

call_tool_pattern = re.compile(
    r'''  public async callTool\(toolId: string, input: any\): Promise<any> \{.*?\n  \}\n\n  /\*\*\n   \* Reads an MCP resource''',
    re.S,
)
call_tool_new = '''  public async callTool(toolId: string, input: any): Promise<any> {
    const config = toolConfigs.find((tool) => tool.name === toolId);
    if (!config) {
      throw new Error(`Tool with id "${toolId}" not found.`);
    }
    return await config.handler(input ?? {}, {
      raindropService: this.raindropService,
      mcpServer: this.server.server,
    });
  }

  /**
   * Reads an MCP resource'''
text, n = call_tool_pattern.subn(call_tool_new, text, count=1)
if n != 1:
    raise SystemExit(f"replace callTool: {n}")

server_resources_pattern = re.compile(
    r'''    const serverResources = \(\(this\.server as any\)\._resources \|\| \[\]\)\.map\(.*?\n    \);\n\n    // Include our static resources and dynamic resource patterns\n''',
    re.S,
)
text, n = server_resources_pattern.subn(
    '    // Include our static resources and dynamic resource patterns\n',
    text,
    count=1,
)
if n != 1:
    raise SystemExit(f"remove SDK private resources read: {n}")

text = replace_once(
    text,
    '    // Combine all resources: server resources, static resources, and dynamic patterns\n    return [...serverResources, ...staticResources, ...dynamicResourcePatterns];\n',
    '    return [...staticResources, ...dynamicResourcePatterns];\n',
    "return app-owned resources only",
)

for forbidden in ("_registeredTools", "._resources", "resourceSubscriptions"):
    if forbidden in text:
        raise SystemExit(f"raindropmcp.service.ts still contains {forbidden}")
mcp_path.write_text(text)

worker_path = ROOT / "src/worker.ts"
text = worker_path.read_text()
text = replace_once(
    text,
    '  RAINDROP_RATE_LIMIT_POINTS?: string;\n  RAINDROP_RATE_LIMIT_DURATION_SECONDS?: string;\n',
    '',
    "remove fake limiter env vars",
)
handler_old = '''const mcpHandler = createMcpHandler(
  () => new RaindropMCPService().getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);
'''
handler_new = '''const parseMaxReadRetries = (value: string | undefined): number => {
  const parsed = Number(value ?? "3");
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 3;
};

const createHandler = (env: Env) =>
  createMcpHandler(
    () =>
      new RaindropMCPService({
        accessToken: env.RAINDROP_ACCESS_TOKEN,
        maxReadRetries: parseMaxReadRetries(env.RAINDROP_RATE_LIMIT_MAX_RETRIES),
        debugHttp: false,
      }).getServer(),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => logger.error("MCP handler error", error),
    },
  );
'''
text = replace_once(text, handler_old, handler_new, "replace Worker handler composition")
text = replace_once(
    text,
    '    return mcpHandler.fetch(portalAuth.request);\n',
    '    return createHandler(env).fetch(portalAuth.request);\n',
    "use explicit Worker config",
)
worker_path.write_text(text)

index_path = ROOT / "src/index.ts"
text = index_path.read_text()
text = replace_once(
    text,
    '  const handle = serveStdio(() => new RaindropMCPService().getServer(), {\n',
    '''  const maxReadRetries = Number(
    process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES ?? "3",
  );
  const serviceConfig = {
    accessToken: process.env.RAINDROP_ACCESS_TOKEN,
    maxReadRetries:
      Number.isInteger(maxReadRetries) && maxReadRetries >= 0
        ? maxReadRetries
        : 3,
    debugHttp: process.env.NODE_ENV === "development",
  };
  const handle = serveStdio(
    () => new RaindropMCPService(serviceConfig).getServer(),
    {
''',
    "stdio explicit service config",
)
text = replace_once(
    text,
    '    onerror: (error) => logger.error("STDIO transport error", error),\n  });\n',
    '      onerror: (error) => logger.error("STDIO transport error", error),\n    },\n  );\n',
    "stdio handler formatting",
)
index_path.write_text(text)

server_path = ROOT / "src/server.ts"
text = server_path.read_text()
node_handler_old = '''const mcpHandler = createMcpHandler(
  () => new RaindropMCPService().getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);
'''
node_handler_new = '''const maxReadRetries = Number(
  process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES ?? "3",
);
const serviceConfig = {
  accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "",
  maxReadRetries:
    Number.isInteger(maxReadRetries) && maxReadRetries >= 0
      ? maxReadRetries
      : 3,
  debugHttp: process.env.NODE_ENV === "development",
};

const mcpHandler = createMcpHandler(
  () => new RaindropMCPService(serviceConfig).getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);
'''
text = replace_once(text, node_handler_old, node_handler_new, "Node HTTP explicit config")
server_path.write_text(text)

retry_path = ROOT / "tests/retry_safety.test.ts"
text = retry_path.read_text()
text = replace_once(
    text,
    'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";\n',
    'import { afterEach, describe, expect, it, vi } from "vitest";\n',
    "remove unused beforeEach import",
)
text = replace_once(
    text,
    '''  beforeEach(() => {
    process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES = "1";
    process.env.RAINDROP_RATE_LIMIT_POINTS = "1000";
    process.env.RAINDROP_RATE_LIMIT_DURATION_SECONDS = "1";
  });

''',
    '',
    "remove retry env setup",
)
text = replace_once(
    text,
    '''    delete process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES;
    delete process.env.RAINDROP_RATE_LIMIT_POINTS;
    delete process.env.RAINDROP_RATE_LIMIT_DURATION_SECONDS;
''',
    '',
    "remove retry env cleanup",
)
text = text.replace(
    'const service = new RaindropService("test-token");',
    'const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });',
)
if text.count('maxReadRetries: 1') != 4:
    raise SystemExit(f"retry test explicit config count={text.count('maxReadRetries: 1')}")
retry_path.write_text(text)

mcp_test_path = ROOT / "tests/mcp.service.test.ts"
text = mcp_test_path.read_text()
text = text.replace(
    '    mcpService = new RaindropMCPService();',
    '    mcpService = new RaindropMCPService({ accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "" });',
)
if text.count('new RaindropMCPService({ accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "" })') != 2:
    raise SystemExit("mcp.service test constructor replacement mismatch")
mcp_test_path.write_text(text)

live_service_path = ROOT / "tests/raindrop.service.test.ts"
text = live_service_path.read_text()
text = text.replace(
    'new RaindropService()',
    'new RaindropService(process.env.RAINDROP_ACCESS_TOKEN ?? "")',
)
live_service_path.write_text(text)

package_path = ROOT / "package.json"
package_data = json.loads(package_path.read_text())
for dep in ("keyv", "rate-limiter-flexible"):
    if dep not in package_data["dependencies"]:
        raise SystemExit(f"missing expected dependency {dep}")
    del package_data["dependencies"][dep]
package_path.write_text(json.dumps(package_data, indent=2, ensure_ascii=False) + "\n")

wrangler_path = ROOT / "wrangler.jsonc"
text = wrangler_path.read_text()
text = replace_once(
    text,
    '    "RAINDROP_RATE_LIMIT_POINTS": "30",\n    "RAINDROP_RATE_LIMIT_DURATION_SECONDS": "60",\n',
    '',
    "remove fake limiter wrangler vars",
)
wrangler_path.write_text(text)

readme_path = ROOT / "README.md"
text = readme_path.read_text()
portal_anchor = '''The Worker does not expose CORS for `/mcp`; browser-origin requests are rejected. Server-to-server requests without an `Origin` header are allowed only after the normal Portal bearer check.

'''
portal_note = '''The Worker does not expose CORS for `/mcp`; browser-origin requests are rejected. Server-to-server requests without an `Origin` header are allowed only after the normal Portal bearer check.

The Worker is stateless per MCP request. Collection/bookmark/search reuse is limited to one service instance and does not claim cross-request caching. Upstream write requests are never automatically resubmitted after reaching Raindrop.io; bounded automatic retries apply only to reads. `RAINDROP_RATE_LIMIT_MAX_RETRIES` controls that read retry ceiling (default `3`).

'''
text = replace_once(text, portal_anchor, portal_note, "document lifecycle semantics")
readme_path.write_text(text)

all_src = "\n".join(p.read_text() for p in (ROOT / "src").rglob("*.ts"))
service_text = service_path.read_text()
mcp_text = mcp_path.read_text()
if "process.env" in service_text:
    raise SystemExit("service layer still contains process.env")
if "RateLimiterMemory" in all_src or 'from "keyv"' in all_src:
    raise SystemExit("removed lifecycle dependencies still imported in src")
if "_registeredTools" in mcp_text or "._resources" in mcp_text:
    raise SystemExit("private MCP SDK field access remains")
if '"resources/subscribe"' in mcp_text or '"resources/unsubscribe"' in mcp_text:
    raise SystemExit("resource subscription handlers remain")
if "subscribe: true" in mcp_text or "listChanged: true" in mcp_text:
    raise SystemExit("unfulfilled list/subscription capability remains")
