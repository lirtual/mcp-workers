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
  const migrationGate=yaml.slice(full,apply);
  const proofNames=[
    ["TERMINAL", "terminal", "terminal_run_id"],
    ["SECOND_TERMINAL", "terminal_second", "second_terminal_run_id"],
    ["THIRD_TERMINAL", "terminal_third", "third_terminal_run_id"],
    ["FOURTH_TERMINAL", "terminal_fourth", "fourth_terminal_run_id"],
    ["FIFTH_TERMINAL", "terminal_fifth", "fifth_terminal_run_id"],
    ["SIXTH_TERMINAL", "terminal_sixth", "sixth_terminal_run_id"],
    ["SEVENTH_TERMINAL", "terminal_seventh", "seventh_terminal_run_id"],
    ["EIGHTH_TERMINAL", "terminal_eighth", "eighth_terminal_run_id"],
    ["NINTH_TERMINAL", "terminal_ninth", "ninth_terminal_run_id"],
    ["TENTH_TERMINAL", "terminal_tenth", "tenth_terminal_run_id"],
    ["ELEVENTH_TERMINAL", "terminal_eleventh", "eleventh_terminal_run_id"],
    ["TWELFTH_TERMINAL", "terminal_twelfth", "twelfth_terminal_run_id"],
  ];
  for(const [name,step,output] of proofNames){
    assert.ok(migrationGate.includes(`WORKFLOW_${name}_RUN_ID: \${{ steps.${step}.outputs.${output} }}`),
      `migration gate must forward verified ${name} Run ID`);
  }
  assert.ok(yaml.slice(apply,physical).includes(conditional));
  assert.match(yaml.slice(physical,publish),/node scripts\/manual-worker-release\.mjs code-release-check workflow-mcp-worker/);
  assert.match(yaml.slice(apply,physical),/wrangler d1 migrations apply workflow-mcp-db --remote/);
});
