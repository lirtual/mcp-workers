/** Choose the existing-schema release path without relaxing the migration fence.
 * Read-only D1 migration metadata must exactly match the files in this commit.
 * If any migration is pending, the original full migration gate still applies.
 */
import { appendFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function selectWorkflowSchemaRelease(response, sourceFiles) {
  if (!Array.isArray(response) || response.length !== 1 ||
      response[0]?.success !== true || !Array.isArray(response[0].results)) {
    throw Error("Workflow D1 migration inventory unavailable");
  }
  const local = [...sourceFiles].filter(name => name.endsWith(".sql")).sort();
  if (!local.length || local.some(name => !/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)) ||
      new Set(local).size !== local.length) {
    throw Error("Workflow source migration inventory invalid");
  }
  const applied = response[0].results.map(row => row?.name);
  if (applied.some(name => typeof name !== "string") ||
      new Set(applied).size !== applied.length ||
      applied.some(name => !local.includes(name))) {
    throw Error("Workflow production migration inventory drift");
  }
  const expectedPrefix = local.slice(0, applied.length);
  if (JSON.stringify([...applied].sort()) !== JSON.stringify(expectedPrefix)) {
    throw Error("Workflow production migrations are not a source prefix");
  }
  return { apply_required: applied.length !== local.length, applied: applied.length, source: local.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) throw Error("Workflow migration inventory response too large");
      chunks.push(chunk);
    }
    const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const files = readdirSync(new URL("../apps/workflow-mcp-worker/migrations/", import.meta.url));
    const result = selectWorkflowSchemaRelease(response, files);
    if (!process.env.GITHUB_OUTPUT) throw Error("Protected release output unavailable");
    appendFileSync(process.env.GITHUB_OUTPUT, "apply_required=" + result.apply_required + "\n");
    console.log("Workflow D1 inventory checked: " + result.applied + "/" + result.source +
      (result.apply_required ? "; full migration fence required" : "; no D1 migration needed"));
  } catch {
    console.error("Workflow D1 migration inventory verification failed");
    process.exitCode = 1;
  }
}
