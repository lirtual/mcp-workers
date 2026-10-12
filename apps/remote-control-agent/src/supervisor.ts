import { createRequire } from "node:module";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { LocalRead } from "./local-read.ts";

const require = createRequire(import.meta.url);

/**
 * Desktop Commander 0.2.52 writes unredacted tool arguments to
 * ~/.claude-server-commander/claude_tool_call.log and unredacted tool results
 * to tool-history.jsonl under the child HOME. Those upstream files are not
 * redacted. Permission, privacy, and retention acceptance belongs to T07.
 * telemetryEnabled is set in the local spawn config below and is not a remote tool.
 */
const PINNED_VERSION = "0.2.52";
const MAX_RESULT_CHARS = 200_000;

export class DeviceUnavailable extends Error {
  constructor() {
    super("The local file service is unavailable.");
    this.name = "DeviceUnavailable";
  }
}

export function desktopCommanderEntry(): string {
  const packageJsonPath = require.resolve("@wonderwhy-er/desktop-commander/package.json");
  const packageJson = require("@wonderwhy-er/desktop-commander/package.json") as { version?: string };
  if (packageJson.version !== PINNED_VERSION) {
    throw new DeviceUnavailable();
  }
  return path.join(path.dirname(packageJsonPath), "dist", "index.js");
}

export function prepareChildHome(childHome: string): void {
  mkdirSync(childHome, { recursive: true, mode: 0o700 });
  chmodSync(childHome, 0o700);
  const configDir = path.join(childHome, ".claude-server-commander");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const configFile = path.join(configDir, "config.json");
  // Empty allowedDirectories is upstream's encoding of "no application path allowlist".
  // Without it, Desktop Commander would confine itself to this disposable HOME.
  writeFileSync(
    configFile,
    `${JSON.stringify({ telemetryEnabled: false, allowedDirectories: [] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(configFile, 0o600);
}

function childEnvironment(childHome: string): Record<string, string> {
  const temporary = path.join(childHome, "tmp");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    HOME: childHome,
    USERPROFILE: childHome,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1",
  };
  const inheritedPath = process.env.PATH;
  if (inheritedPath && !inheritedPath.startsWith("()")) env.PATH = inheritedPath;
  const lang = process.env.LANG;
  if (lang && !lang.startsWith("()")) env.LANG = lang;
  return env;
}

function textFromContent(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") return null;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") return null;
    parts.push(record.text);
  }
  const text = parts.join("");
  if (text.length > MAX_RESULT_CHARS) return null;
  return text;
}

export class DesktopCommanderSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<void> | null = null;
  private readonly childHome: string;

  constructor(childHome: string) {
    this.childHome = childHome;
  }

  async readFile(read: LocalRead): Promise<string> {
    await this.ensureStarted();
    const client = this.client;
    if (!client) throw new DeviceUnavailable();

    const args: Record<string, string | number | boolean> = {
      path: read.path,
      isUrl: false,
    };
    if (read.offset !== undefined) args.offset = read.offset;
    if (read.length !== undefined) args.length = read.length;

    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool({ name: "read_file", arguments: args });
    } catch {
      throw new DeviceUnavailable();
    }

    if (result.isError) {
      throw new ReadFailed();
    }

    const text = textFromContent(result.content);
    if (text === null) throw new ReadFailed();
    return text;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.starting = null;
    const pid = transport?.pid ?? null;
    try {
      await client?.close();
    } catch {
      // The child is terminated below. Close errors stay off the log.
    }
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The child already exited.
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (!this.starting) this.starting = this.start();
    try {
      await this.starting;
    } catch (error) {
      this.starting = null;
      throw error;
    }
  }

  private async start(): Promise<void> {
    let entry: string;
    try {
      entry = desktopCommanderEntry();
    } catch {
      throw new DeviceUnavailable();
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--no-onboarding"],
      cwd: this.childHome,
      env: childEnvironment(this.childHome),
      stderr: "ignore",
    });
    const client = new Client(
      { name: "remote-control-agent", version: "0.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), 30_000);
        }),
      ]);
    } catch {
      try {
        await client.close();
      } catch {
        // Already unreachable.
      }
      throw new DeviceUnavailable();
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    this.transport = transport;
    this.client = client;
  }
}

export class ReadFailed extends Error {
  constructor() {
    super("The file read failed.");
    this.name = "ReadFailed";
  }
}
