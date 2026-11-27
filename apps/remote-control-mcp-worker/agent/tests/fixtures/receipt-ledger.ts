// Historical schema fixture only; no implementation of receipt admission.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function seedUnknownReceipt(file: string, operationId: string, tool: string,
  digest: string, timestamp: string, summary: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE receipts (operation_id TEXT PRIMARY KEY NOT NULL,tool_name TEXT NOT NULL,argument_digest TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,safe_result_summary TEXT,session_id TEXT,guarded INTEGER NOT NULL CHECK(guarded IN (0,1))); PRAGMA user_version=1;");
    db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,NULL,1)")
      .run(operationId, tool, digest, "unknown", timestamp, timestamp, summary);
  } finally { db.close(); }
}
