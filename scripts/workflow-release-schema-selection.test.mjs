import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {selectWorkflowSchemaRelease} from "./workflow-release-schema-selection.mjs";

const files = readdirSync(new URL("../apps/workflow-mcp-worker/migrations/", import.meta.url))
  .filter(name => name.endsWith(".sql")).sort();
const response = names => [{success:true,results:names.map(name=>({name}))}];

test("new source migration cannot bypass the production D1 migration fence", () => {
  assert.equal(files.length,23);
  assert.equal(files.at(-2),"0022_drop_claim_receipts.sql");
  assert.equal(files.at(-1),"0023_execution_terminal_proof.sql");
  assert.deepEqual(selectWorkflowSchemaRelease(response(files.slice(0,-1)),files),
    {apply_required:true,applied:22,source:23});
  assert.deepEqual(selectWorkflowSchemaRelease(response(files),files),
    {apply_required:false,applied:23,source:23});
});
test("pending migration keeps original strict schema migration gate", () => {
  assert.deepEqual(selectWorkflowSchemaRelease(response(files.slice(0,20)),files),
    {apply_required:true,applied:20,source:23});
  assert.deepEqual(selectWorkflowSchemaRelease(response([]),files),
    {apply_required:true,applied:0,source:23});
  assert.deepEqual(selectWorkflowSchemaRelease(response(files),[...files,"0024_new.sql"]),
    {apply_required:true,applied:23,source:24});
});
test("unknown, out of order, duplicate and malformed inventories fail closed", () => {
  for (const data of [
    response(["0022_unknown.sql"]),
    response([files[0],files[2]]),
    response([files[0],files[0]]),
    [{success:false,results:[]}],
    [{success:true,results:[{name:42}]}],
    [{success:true,results:null}],
    [],
  ]) assert.throws(()=>selectWorkflowSchemaRelease(data,files));
  assert.throws(()=>selectWorkflowSchemaRelease(response([]),[]));
  assert.throws(()=>selectWorkflowSchemaRelease(response([]),["INVALID.sql"]));
});
test("protected release verifies existing schema without a retired migration path", () => {
 const yaml=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
 const publish=yaml.indexOf("      - name: Publish exactly selected Worker");
 assert.ok(publish>0);
 assert.match(yaml.slice(publish),/workflow-check workflow-mcp-worker[\s\S]*pnpm exec wrangler deploy/);
 assert.doesNotMatch(yaml,/workflow-prepare|workflow-backfill|workflow-cutover-recheck|wrangler d1 migrations apply workflow-mcp-db/);
 assert.doesNotMatch(yaml,/WORKFLOW_(?:[A-Z_]+_)?TERMINAL_RUN_ID|TERMINAL_PROOF_KIND|steps\.terminal/);
 const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
 assert.match(ci,/node --test [^\n]*scripts\/workflow-release-schema-selection\.test\.mjs/);
});
