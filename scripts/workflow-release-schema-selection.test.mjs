import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {selectWorkflowSchemaRelease} from "./workflow-release-schema-selection.mjs";

const files = readdirSync(new URL("../apps/workflow-mcp-worker/migrations/", import.meta.url))
  .filter(name => name.endsWith(".sql")).sort();
const response = names => [{success:true,results:names.map(name=>({name}))}];

test("current source and production migration inventories require no D1 writes", () => {
  assert.equal(files.length,21);
  assert.deepEqual(selectWorkflowSchemaRelease(response(files),files),
    {apply_required:false,applied:21,source:21});
});
test("pending migration keeps original strict schema migration gate", () => {
  assert.deepEqual(selectWorkflowSchemaRelease(response(files.slice(0,-1)),files),
    {apply_required:true,applied:20,source:21});
  assert.deepEqual(selectWorkflowSchemaRelease(response([]),files),
    {apply_required:true,applied:0,source:21});
  assert.deepEqual(selectWorkflowSchemaRelease(response(files),[...files,"0022_new.sql"]),
    {apply_required:true,applied:21,source:22});
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
test("protected release only skips a redundant apply, preserving full migration and physical gates", () => {
  const yaml=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  const detect=yaml.indexOf("      - name: Classify Workflow schema migrations without changing D1");
  const full=yaml.indexOf("      - name: Enforce original all-Workflow migration gate before any ordinary D1 writes");
  const apply=yaml.indexOf("      - name: Apply complete Workflow D1 migrations");
  const physical=yaml.indexOf("      - name: Verify code-only Workflow D1 gate at publication");
  const publish=yaml.indexOf("      - name: Publish exactly selected Worker");
  assert.ok(detect>0 && full>detect && apply>full && physical>apply && publish>physical);
  const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  assert.match(ci,/node --test [^\n]*scripts\/workflow-release-schema-selection\.test\.mjs/);
  assert.match(yaml.slice(detect,full),/id: workflow_schema[\s\S]*SELECT name FROM d1_migrations ORDER BY name[\s\S]*node scripts\/workflow-release-schema-selection\.mjs/);
  const conditional="steps.workflow_schema.outputs.apply_required == 'true'";
  assert.ok(yaml.slice(full,apply).includes(conditional));
  assert.ok(yaml.slice(apply,physical).includes(conditional));
  assert.match(yaml.slice(physical,publish),/node scripts\/manual-worker-release\.mjs code-release-check workflow-mcp-worker/);
  assert.match(yaml.slice(apply,physical),/wrangler d1 migrations apply workflow-mcp-db --remote/);
});
