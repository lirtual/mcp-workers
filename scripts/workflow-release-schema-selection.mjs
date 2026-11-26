/** Choose the existing-schema release path without relaxing the migration fence.
 * Read-only D1 migration metadata must exactly match the files in this commit.
 * If any migration is pending, the original full migration gate still applies.
 */

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
