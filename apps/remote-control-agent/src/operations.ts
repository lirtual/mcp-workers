import { createHash } from "node:crypto";
import { mkdir, readFile, rename, chmod, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OperationState = "admitted" | "running" | "completed" | "failed" | "unknown";

export interface OperationReceipt {
  operation_id: string;
  tool_name: "write_file" | "create_directory" | "edit_block" | "move_file" | "start_process";
  argument_digest: string;
  state: OperationState;
  created_at: string;
  updated_at: string;
  safe_result_summary?: string;
  session_id?: string;
}

interface StoreData {
  version: 1;
  receipts: OperationReceipt[];
}

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function operationDigest(tool: string, args: unknown): string {
  return createHash("sha256").update(canonical({ tool, arguments: args })).digest("hex");
}

export class ReceiptStore {
  readonly directory: string;
  private readonly file: string;
  private data: StoreData = { version: 1, receipts: [] };
  private chain: Promise<void> = Promise.resolve();

  constructor(directory = path.join(os.homedir(), ".local", "state", "mcp-workers", "remote-control-agent")) {
    this.directory = directory;
    this.file = path.join(directory, "operation-receipts.json");
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text) as StoreData;
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) throw new Error("invalid receipts");
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Receipt store could not be read.");
    }
    let changed = false;
    const now = Date.now();
    this.data.receipts = this.data.receipts.filter((receipt) => {
      if (!["admitted", "running", "completed", "failed", "unknown"].includes(receipt.state)) {
        throw new Error("Receipt store contains invalid state.");
      }
      if ((receipt.state === "completed" || receipt.state === "failed" || receipt.state === "unknown") &&
          now - Date.parse(receipt.created_at) > RECEIPT_TTL_MS) {
        changed = true;
        return false;
      }
      if (receipt.state === "admitted" || receipt.state === "running") {
        receipt.state = "unknown";
        delete receipt.session_id;
        receipt.safe_result_summary = "Effect cannot be established after restart.";
        receipt.updated_at = new Date().toISOString();
        changed = true;
      }
      if (receipt.tool_name === "start_process" && receipt.session_id) {
        delete receipt.session_id;
        changed = true;
      }
      return true;
    });
    if (changed || !(await this.fileExists())) await this.persist();
  }

  private async fileExists(): Promise<boolean> {
    try { await readFile(this.file); return true; } catch { return false; }
  }

  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  private async persist(): Promise<void> {
    const temp = path.join(this.directory, `.receipts-${process.pid}-${Date.now()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.data), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, this.file);
    await chmod(this.file, 0o600);
    const dir = await open(this.directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }

  async admit(operationId: string, toolName: OperationReceipt["tool_name"], digest: string): Promise<{ kind: "new" | "same" | "conflict" | "full"; receipt?: OperationReceipt }> {
    return this.serialize(async () => {
      const now = new Date().toISOString();
      const cutoff = Date.now() - RECEIPT_TTL_MS;
      this.data.receipts = this.data.receipts.filter((r) =>
        !(["completed", "failed", "unknown"].includes(r.state) && Date.parse(r.created_at) < cutoff));
      const existing = this.data.receipts.find((r) => r.operation_id === operationId);
      if (existing) return { kind: existing.tool_name === toolName && existing.argument_digest === digest ? "same" : "conflict", receipt: { ...existing } };
      if (this.data.receipts.length >= MAX_RECEIPTS) {
        return { kind: "full" };
      }
      const receipt: OperationReceipt = {
        operation_id: operationId,
        tool_name: toolName,
        argument_digest: digest,
        state: "admitted",
        created_at: now,
        updated_at: now,
      };
      this.data.receipts.push(receipt);
      await this.persist();
      return { kind: "new", receipt: { ...receipt } };
    });
  }

  async update(operationId: string, state: OperationState, summary: string, sessionId?: string): Promise<OperationReceipt> {
    return this.serialize(async () => {
      const receipt = this.data.receipts.find((r) => r.operation_id === operationId);
      if (!receipt) throw new Error("Receipt disappeared.");
      receipt.state = state;
      receipt.updated_at = new Date().toISOString();
      receipt.safe_result_summary = summary.slice(0, 128);
      if (sessionId) receipt.session_id = sessionId;
      await this.persist();
      return { ...receipt };
    });
  }

  async get(operationId: string): Promise<OperationReceipt | null> {
    return this.serialize(async () => {
      const receipt = this.data.receipts.find((r) => r.operation_id === operationId);
      if (!receipt) return null;
      if (Date.now() - Date.parse(receipt.created_at) > RECEIPT_TTL_MS) {
        this.data.receipts = this.data.receipts.filter((r) => r !== receipt);
        await this.persist();
        return null;
      }
      return { ...receipt };
    });
  }

  async close(): Promise<void> {
    await this.chain;
  }
}
