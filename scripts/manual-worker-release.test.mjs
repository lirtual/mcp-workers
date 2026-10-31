import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptExists, activeVersion, verifyBindings, parseWranglerVersion, verifyPublishedVersion, verifyWorkflowReleaseConfig, verifyWorkflowD1Readiness, verifyWorkflowMigrationReadiness, verifyWorkflowCodeReleaseReadiness, verifyDatabaseCutoverSource, verifyDatabaseHyperdriveSource, parseDatabaseCutoverIds, databaseD1ReadinessSql, verifyDatabaseD1Readiness, WORKFLOW_MIGRATION_READINESS_SQL, retryReleaseReadback, readConfiguration } from "./manual-worker-release.mjs";

const required = [
  { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
  { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
];
const secretList = [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }];
const goodSettings = { bindings: required, observability: { enabled: true, logs: { invocation_logs: true } } };

test("Raindrop required Secret names and bindings are preserved", () => {
  assert.equal(verifyBindings("raindrop-mcp-worker", goodSettings, secretList), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", goodSettings, []), /Secret missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, bindings: [] }, secretList),
    /binding missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, observability: {} }, secretList),
    /Invocation Logs/);
  assert.throws(() => verifyBindings("not-a-worker", goodSettings, secretList), /target/);
});

test("Workflow deployment readback retries only missing Secret inventory", async () => {
  let count = 0;
  const intervals = [];
  const result = await retryReleaseReadback(async () => {
    count++;
    if (count <= 2) throw Error("Required Secret binding missing: MCP_ACCESS_TOKEN");
    return { ready: true };
  }, async ms => {intervals.push(ms);});
  assert.deepEqual(result,{ready:true});
  assert.equal(count,3);
  assert.deepEqual(intervals,[2000,2000]);

  let immediate = 0;
  await assert.rejects(retryReleaseReadback(async () => {
    immediate++;
    throw Error("Workflow Action OIDC audience drift");
  }, async () => {throw Error("must not sleep");}), /OIDC audience drift/);
  assert.equal(immediate,1);

  let versions = 0;
  const expected = "11111111-1111-4111-8111-111111111111";
  const previous = {mode:"update",version_id:"00000000-0000-4000-8000-000000000000",
    deployment_id:"old-deployment"};
  const verified = await retryReleaseReadback(async () => {
    versions++;
    const observed = {version_id:versions < 3 ? previous.version_id : expected,
      deployment_id:versions < 3 ? previous.deployment_id : "new-deployment"};
    verifyPublishedVersion(previous,observed,expected);
    return observed;
  }, async () => {});
  assert.equal(verified.version_id,expected);
  assert.equal(versions,3);

  let max = 0;
  await assert.rejects(retryReleaseReadback(async () => {
    max++;
    throw Error("Required runtime Secret missing: MCP_PORTAL_CLIENT_SECRET");
  }, async () => {}), /runtime Secret missing/);
  assert.equal(max,6);
});

test("Active-version readback requires exactly one 100 percent version", () => {
  const good = { deployments: [{ id: "deployment-one", versions: [{ version_id: "version-one", percentage: 100 }] }] };
  assert.deepEqual(activeVersion(good), { deployment_id: "deployment-one", version_id: "version-one" });
  assert.throws(() => activeVersion({ deployments: [] }), /unambiguous/);
  assert.throws(() => activeVersion({ deployments: [{ id: "mixed", versions: [
    { version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 },
  ] }] }), /unambiguous/);
});

test("IMA accepts old CLIENT_ID Variable in preflight and requires new Variable after release", () => {
  const worker = "ima-mcp-worker";
  const names = ["MCP_ACCESS_TOKEN", "IMA_API_KEY"];
  const secrets = names.map(name => ({ name }));
  const durable = { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" };
  const observability = { enabled: true, logs: { invocation_logs: true }, traces: { enabled: true } };
  const old = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "CLIENT_ID", type: "plain_text", text: "existing-client-id" }, durable], observability };
  assert.equal(verifyBindings(worker, old, secrets, { mode: "preflight" }), true);
  assert.throws(() => verifyBindings(worker, old, secrets, { mode: "readback" }), /IMA legacy CLIENT_ID|IMA_CLIENT_ID.*Variable/);
  const settings = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "IMA_CLIENT_ID", type: "plain_text", text: "ima-client-id" }, durable], observability };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.filter(x => x.name !== "IMA_CLIENT_ID") }, secrets, { mode: "readback" }), /IMA_CLIENT_ID.*Variable|IMA legacy CLIENT_ID/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.map(x => x.name === "IMA_CLIENT_ID" ? { ...x, text: " " } : x) },
    secrets, { mode: "readback" }), /IMA_CLIENT_ID.*Variable|IMA legacy CLIENT_ID/);
  assert.throws(() => verifyBindings(worker, settings,
    [...secrets, { name: "IMA_CLIENT_ID" }], { mode: "readback" }), /legacy IMA_CLIENT_ID Secret/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [
    ...settings.bindings, { name: "CLIENT_ID", type: "plain_text", text: "legacy" },
  ] }, secrets, { mode: "readback" }), /legacy CLIENT_ID/);

  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [
    ...settings.bindings, { name: "R2_BUCKET", type: "r2_bucket" },
  ] }, secrets, { mode: "preflight" }), /Legacy IMA R2/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings:
    settings.bindings.filter(x => x.name !== "IMA_IMAGE_REFRESH_SHARD") }, secrets), /Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings, observability: {
    enabled: true, logs: { invocation_logs: true },
  } }, secrets), /tracing drift/);
});

test("Database production release verifies D1 before the first Wrangler deploy", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const a = workflow.indexOf("Verify Database D1 schema and fresh registry before publication (read-only)");
  const b = workflow.indexOf("Publish exactly selected Worker", a);
  assert.ok(a > 0 && b > a, "Database D1 guard must run before publish");
  const step = workflow.slice(a, b);
  assert.match(step, /if: inputs\.worker == 'database-mcp-worker'/);
  assert.match(step, /database-d1-sql database-mcp-worker/);
  assert.match(step, /database-d1-check database-mcp-worker/);
  assert.doesNotMatch(step, /DATABASE_CUTOVER_EXPECTED_IDS/, 'fixed original IDs require no extra Variable');
  assert.match(step, /wrangler d1 execute database-mcp-registry --remote --json/);
  assert.doesNotMatch(step, /\bmigrations apply\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

test("Database release must inspect an exact-email Cloudflare Access policy before publish", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const d1 = workflow.indexOf("Verify Database D1 schema and fresh registry before publication");
  const access = workflow.indexOf("Verify Database Owner Access policy before publication");
  const publish = workflow.indexOf("Publish exactly selected Worker");
  assert.ok(d1 > 0 && access > d1 && publish > access);
  const block = workflow.slice(access, publish);
  assert.match(block, /if: inputs\.worker == 'database-mcp-worker'/);
  assert.match(block, /run: node scripts\/database-owner-access\.mjs/);
  assert.match(block, /vars\.ACCESS_AUD/);
  assert.match(block, /vars\.OWNER_EMAIL/);
  assert.doesNotMatch(block, /\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b/);
});

test("Database D1 cutover rejects missing reviewed IDs without querying upstream", () => {
  const legacy = ["old_mysql", "old_pg"];
  assert.deepEqual(parseDatabaseCutoverIds(JSON.stringify(legacy)), legacy);
  const sql = databaseD1ReadinessSql(legacy);
  assert.match(sql, /d1_migrations/);
  assert.match(sql, /preserved_count/);
  assert.match(sql, /active_count/);
  assert.match(sql, /id IN \('old_mysql','old_pg'\)/);
  assert.doesNotMatch(sql, /SELECT\s+\*|\bpassword\b|\bplaintext\b|\burl\b/i);
  for (const invalid of [undefined, "", "[]", "{}", '["a","a"]',
    JSON.stringify(["ok", "bad' OR 1=1"]), JSON.stringify(["ok", null])]) {
    assert.throws(() => parseDatabaseCutoverIds(invalid), /expected IDs|JSON invalid/);
  }
  const result = counts => [{ success: true, results: [counts] }];
  const valid = { migration_count: 3, resource_claim_column: 1, apply_receipt_column: 1, inflight_column: 1, inflight_delete_trigger: 1, inflight_rebind_trigger: 1, reviewed_rebind_trigger: 1, retired_config_column: 1, retired_binding_column: 1, retired_resource_trigger: 1, reserved_count: 0, record_count: 2, preserved_count: 2, active_count: 2, retired_count: 0, reused_count: 0, malformed_count: 0 };
  assert.deepEqual(verifyDatabaseD1Readiness(result(valid), 2),
    { record_count: 2, preserved_count: 2, active_count: 2 });
  assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, record_count: 0, preserved_count: 0 }), 2),
    /missing reviewed legacy/);
  assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, preserved_count: 1 }), 2),
    /missing reviewed legacy/);
  for (const active_count of [0, 1, 3]) {
    assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, active_count }), 2),
      /release blocked: reviewed legacy connections are disabled/);
  }
  assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, migration_count: 0 }), 2),
    /migration not applied/);
  assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, record_count: 11 }), 2),
    /inventory invalid/);
  assert.throws(() => verifyDatabaseD1Readiness(result({ ...valid, malformed_count: 1 }), 2),
    /inventory invalid/);
  assert.throws(() => verifyDatabaseD1Readiness([{ success: false, results: [valid] }], 2),
    /unavailable/);
  assert.throws(() => verifyDatabaseD1Readiness(result(valid), 0), /expected ID count missing/);
});


test('Database release fails closed without complete persisted drain-fence schema', () => {
  const sql=databaseD1ReadinessSql(['source_mysql']);
  for(const name of ['inflight_column','inflight_delete_trigger','inflight_rebind_trigger','reviewed_rebind_trigger','retired_config_column','retired_binding_column','retired_resource_trigger']) {
    assert.ok(sql.includes(' AS '+name),'Release query must prove '+name);
  }
  const base={migration_count:3,resource_claim_column:1,apply_receipt_column:1,
    inflight_column:1,inflight_delete_trigger:1,inflight_rebind_trigger:1,reviewed_rebind_trigger:1,retired_config_column:1,retired_binding_column:1,retired_resource_trigger:1,
    reserved_count:0,record_count:1,preserved_count:1,active_count:1,
    retired_count:0,reused_count:0,malformed_count:0};
  const wrap=row=>[{success:true,results:[row]}];
  assert.doesNotThrow(()=>verifyDatabaseD1Readiness(wrap(base),1,'registry'));
  for(const bad of [{inflight_column:0},{inflight_delete_trigger:0},{inflight_rebind_trigger:0},
    {inflight_column:2},{inflight_rebind_trigger:2}, {reviewed_rebind_trigger:0}, {inflight_delete_trigger:null},{retired_config_column:0},{retired_binding_column:0},{retired_resource_trigger:0}]){
    assert.throws(()=>verifyDatabaseD1Readiness(wrap({...base,...bad}),1,'registry'));
  }
});

test("subsequent Database releases allow updated 0–10 connection inventory while retaining schema/retirement checks", () => {
  const base = { migration_count: 3, resource_claim_column: 1, apply_receipt_column: 1, inflight_column: 1, inflight_delete_trigger: 1, inflight_rebind_trigger: 1, reviewed_rebind_trigger: 1, retired_config_column: 1, retired_binding_column: 1, retired_resource_trigger: 1, reserved_count: 0, record_count: 0, preserved_count: 0,
    active_count: 0, retired_count: 2, reused_count: 0, malformed_count: 0 };
  const result = row => [{ success: true, results: [row] }];
  assert.deepEqual(verifyDatabaseD1Readiness(result(base), 2, 'registry'),
    { record_count: 0, preserved_count: 0, active_count: 0 });
  assert.deepEqual(verifyDatabaseD1Readiness(result({ ...base, record_count: 10,
    preserved_count: 1, active_count: 0 }), 2, 'registry'),
    { record_count: 10, preserved_count: 1, active_count: 0 });
  assert.throws(() => verifyDatabaseD1Readiness(result(base), 2, 'cutover'),
    /missing reviewed legacy/);
  for (const bad of [
    { record_count: 11 }, { reused_count: 1 }, { malformed_count: 1 },
    { migration_count: 1 }, { active_count: 1 }, { preserved_count: 3 },
    { retired_count: -1 }, { resource_claim_column: 0 }, { apply_receipt_column: 0 }, { reserved_count: 11 }
  ]) assert.throws(() => verifyDatabaseD1Readiness(result({ ...base, ...bad }), 2, 'registry'));
  assert.throws(() => verifyDatabaseD1Readiness(result(base), 2, 'invalid'), /phase invalid/);
});

test("generated Database D1 release SQL executes against actual SQLite schema", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(readFileSync(new URL("../apps/database-mcp-worker/migrations/0001_connections.sql",
      import.meta.url), "utf8"));
    sql.exec(readFileSync(new URL("../apps/database-mcp-worker/migrations/0002_transport_and_retired_ids.sql", import.meta.url), "utf8"));
    for (const name of ['0003_hyperdrive_operations.sql']) {
      sql.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/' + name,import.meta.url),'utf8'));
    }
    sql.exec("CREATE TABLE d1_migrations (name TEXT NOT NULL)");
    sql.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run("0001_connections.sql");
    sql.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run("0002_transport_and_retired_ids.sql");
    for(const name of ['0003_hyperdrive_operations.sql']) {
      sql.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name);
    }
    const add = sql.prepare("INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) VALUES (?, ?, 'direct', ?, ?, ?, 1,1,1)");
    add.run("source_mysql", "mysql", "active", "x".repeat(48), "key_v1");
    add.run("source_pg", "postgres", "disabled", "y".repeat(48), "key_v1");
    const query = databaseD1ReadinessSql(["source_mysql", "source_pg"]);
    const execute = () => [{ success: true, results: [sql.prepare(query).get()] }];
    assert.throws(() => verifyDatabaseD1Readiness(execute(), 2),
      /release blocked: reviewed legacy connections are disabled/);
    sql.prepare("UPDATE database_connections SET status='active' WHERE id=?").run("source_pg");
    assert.deepEqual(verifyDatabaseD1Readiness(execute(), 2),
      { record_count: 2, preserved_count: 2, active_count: 2 });
    sql.prepare("UPDATE database_connections SET ciphertext='invalid' WHERE id=?").run("source_mysql");
    assert.throws(() => verifyDatabaseD1Readiness(execute(), 2), /inventory invalid/);
    sql.prepare("DELETE FROM database_connections WHERE id=?").run("source_mysql");
    assert.throws(() => verifyDatabaseD1Readiness(execute(), 2), /missing reviewed legacy/);
    verifyDatabaseD1Readiness(execute(), 2, 'registry');
    // Simulate the pre-apply schema; the new handoff trigger depends on this column.
    sql.exec('DROP TRIGGER database_connection_respects_reservation');
    sql.exec('ALTER TABLE hyperdrive_operations DROP COLUMN apply_run_id');
    assert.throws(() => verifyDatabaseD1Readiness(execute(), 2, 'registry'), /lifecycle migration not applied/);
  } finally {
    sql.close();
  }
});

test("Database transition validates reviewed D1, Owner route and two throttles before release", () => {
  const reviewedBindings = JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  const source = {
    name: "database-mcp-worker", main: "src/index.ts",
    secrets: { required: ["MCP_ACCESS_TOKEN", "DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN"] },
    workers_dev: true, preview_urls: false,
    hyperdrive: reviewedBindings.map(x => ({ binding: x.binding, id: x.id })),
    d1_databases: [{ binding: "DB", database_name: "database-mcp-registry",
      database_id: "cbfe6a05-4979-4e6a-9cc2-4f6468586e4a", migrations_dir: "migrations" }],
    vars: { DATABASE_SETUP_HOST: "database-owner.example.com" },
    routes: [{ pattern: "database-owner.example.com", custom_domain: true }],
    ratelimits: [
      { name: "RATE_LIMITER", namespace_id: "1001", simple: { limit: 120, period: 60 } },
      { name: "SETUP_RATE_LIMITER", namespace_id: "1002", simple: { limit: 20, period: 60 } }
    ]
  };
  assert.equal(verifyDatabaseCutoverSource(source), true);
  const broken = (change, message) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(() => verifyDatabaseCutoverSource(candidate), message);
  };
  broken(x => { x.d1_databases = undefined; }, /dedicated production D1/);
  broken(x => { x.d1_databases[0].database_id = "FILL_ME_IN"; }, /dedicated production D1/);
  broken(x => { x.secrets.required.push("DATABASE_CONFIG"); }, /never legacy DATABASE_CONFIG/);
  broken(x => { x.hyperdrive[0].id = '00000000000000000000000000000000'; }, /Hyperdrive binding/);
  broken(x => { x.routes = []; }, /dedicated HTTPS hostname/);
  broken(x => { x.routes[0].pattern = "other.example.com"; }, /dedicated HTTPS hostname/);
  broken(x => { x.ratelimits[1].simple.limit = 100; }, /rate-limit policies/);
  const names = ["MCP_ACCESS_TOKEN", "DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN"];
  const limiter = source.ratelimits[0];
  const setup = source.ratelimits[1];
  const list = names.map(name => ({ name }));
  const settings = {
    bindings: [...names.map(name => ({ name, type: "secret_text" })),
      { name: "DB", type: "d1", id: source.d1_databases[0].database_id },
      ...source.hyperdrive.map(x => ({ name: x.binding, type: "hyperdrive", id: x.id })),
      { name: "DATABASE_SETUP_HOST", type: "plain_text", text: source.vars.DATABASE_SETUP_HOST },
      ...["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"].map(name =>
        ({ name, type: "plain_text", text: "approved-owner" })),
      { ...limiter, type: "ratelimit" }, { ...setup, type: "ratelimit" }],
    observability: { enabled: true, logs: { invocation_logs: true } }
  };
  assert.equal(verifyBindings("database-mcp-worker", settings, list, {
    mode: "readback", sourceConfig: source
  }), true);
  const check = (bindingName, regex) => assert.throws(() => verifyBindings("database-mcp-worker",
    { ...settings, bindings: settings.bindings.filter(x => x.name !== bindingName) },
    list, { mode: "readback", sourceConfig: source }), regex);
  check("DB", /D1 binding mismatch/);
  check("SETUP_RATE_LIMITER", /SETUP_RATE_LIMITER/);
  check("ACCESS_AUD", /Access variable missing/);
  check(source.hyperdrive[0].binding, /Hyperdrive binding IDs/);
  assert.throws(() => verifyBindings("database-mcp-worker", settings,
    list.filter(x => x.name !== "DATABASE_ENCRYPTION_KEY"),
    { mode: "readback", sourceConfig: source }), /DATABASE_ENCRYPTION_KEY/);
  assert.equal(verifyBindings("database-mcp-worker", settings, list, {
    mode: "preflight", sourceConfig: source
  }), true);
});

test("Remote production requires its own DO and rejects Preview namespace reuse", () => {
  const worker = "remote-control-mcp-worker";
  const previewNs = "c086eb6384ad41df9de13765d868324a";
  const productionNs = "abcd1234abcd1234abcd1234abcd1234";
  const prod = { bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_INSTALL_ORIGIN", type: "plain_text", text: "https://rca.lirtual.dpdns.org" },
    { name: "DEVICE_COORDINATOR", class_name: "DeviceCoordinator",
      type: "durable_object_namespace", namespace_id: productionNs },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  const secrets = [{name:"MCP_ACCESS_TOKEN"}];
  const options = { mode: "readback", previousNamespaceId: previewNs,
    sourceConfig: { routes: [{ pattern: "rca.lirtual.dpdns.org", custom_domain: true }] } };
  assert.equal(verifyBindings(worker, prod, secrets, options), true);
  assert.throws(() => verifyBindings(worker, prod, [], options), /Secret missing/);
  for (const name of ["BROWSER_APPROVAL_ACCESS_ISSUER",
    "BROWSER_APPROVAL_ACCESS_AUD","BROWSER_APPROVAL_ALLOWED_EMAIL",
    "BROWSER_APPROVAL_PUBLIC_ORIGIN"]) {
    assert.throws(() => verifyBindings(worker, { ...prod, bindings: [...prod.bindings,
      { name, type: name === "BROWSER_APPROVAL_PUBLIC_ORIGIN" ? "plain_text" : "secret_text" }] },
      secrets, options), /Retired Remote Control approval bindings/);
  }
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.filter(x => x.name !== "REMOTE_CONTROL_INSTALL_ORIGIN"),
  }, secrets, options), /installer origin/);
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.map(x => x.name === "REMOTE_CONTROL_INSTALL_ORIGIN"
      ? { ...x, text: "https://evil.example" } : x),
  }, secrets, options), /installer origin/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: prod.bindings.map(x => x.name === "DEVICE_COORDINATOR"
      ? { ...x, namespace_id: previewNs } : x),
  }, secrets, options), /distinct from Preview/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: [...prod.bindings,
      { name: "REMOTE_CONTROL_V2_ONLY", type: "plain_text", text: "true" }],
  }, secrets, options), /runtime switches/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: [...prod.bindings,
      { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service" }],
  }, secrets, options), /VPC/);
  const previous = { ...prod, bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    ...["BROWSER_APPROVAL_ACCESS_ISSUER","BROWSER_APPROVAL_ACCESS_AUD","BROWSER_APPROVAL_ALLOWED_EMAIL"].map(name=>({name,type:"secret_text"})),
    { name: "REMOTE_CONTROL_V2_ONLY", type: "plain_text", text: "true" },
    { name: "V2_OWNER", type: "durable_object_namespace", namespace_id: previewNs,
      class_name: "V2OwnerCoordinator", script_name: "remote-control-v2-preview" },
  ] };
  assert.equal(verifyBindings(worker, previous, secrets,
    { mode: "preflight", previousNamespaceId: previewNs }), true);
  assert.throws(() => verifyBindings(worker, previous, secrets, options), /DeviceCoordinator/);
  // A former Preview script and its DO can be deleted after cutover. Readback
  // compares against the saved preflight namespace, not a live Preview call.
  assert.equal(verifyBindings(worker, prod, secrets,
    options), true);
  assert.equal(verifyBindings(worker, prod, secrets,
    { mode: "preflight" }), true, "subsequent releases need no Preview worker");
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.map(x => x.name === "DEVICE_COORDINATOR"
      ? { ...x, script_name: "remote-control-v2-preview" } : x),
  }, secrets, options), /distinct from Preview/);
  assert.throws(() => verifyBindings(worker, { ...previous,
    bindings: previous.bindings.map(x => x.name === "V2_OWNER"
      ? { ...x, script_name: "unknown-worker" } : x),
  }, secrets, { mode: "preflight" }), /DeviceCoordinator/,
    "legacy preflight requires the known old Preview source");
});

test("Wrangler output requires a parseable release id, not upload-only success", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(parseWranglerVersion("Current Version ID: " + id), id);
  assert.throws(() => parseWranglerVersion("Uploaded script"), /release Version ID/);
});

test("readback must match exact newly published Wrangler version", () => {
  const old = { version_id: "00000000-0000-4000-8000-000000000000", deployment_id: "old" };
  const id = "12345678-1234-4234-8234-123456789abc";
  const current = { version_id: id, deployment_id: "new" };
  assert.equal(verifyPublishedVersion(old, current, id), true);
  assert.throws(() => verifyPublishedVersion(old, current, "22222222-2222-4222-8222-222222222222"), /does not match/);
  assert.throws(() => verifyPublishedVersion(old, current, ""), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, current, undefined), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, old, old.version_id), /did not change/);
  assert.equal(verifyPublishedVersion({ mode: "bootstrap" }, current, id), true);
  assert.throws(() => verifyPublishedVersion({ mode: "bootstrap" }, current,
    "22222222-2222-4222-8222-222222222222"), /does not match/);
});

test("manual release scope stages the pinned Agent only for Remote Control", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      - id: scope\n") && workflow.includes("        run: node scripts/select-affected-apps.mjs"), "manual scope entry exists");
  const selector = new URL("./select-affected-apps.mjs", import.meta.url);
  function runManual(worker, ref = "refs/heads/main") {
    const dir = mkdtempSync(join(tmpdir(), "remote-release-scope-"));
    const output = join(dir, "outputs");
    try {
      execFileSync(process.execPath, [selector.pathname], {
        env: { ...process.env, EVENT_NAME: "workflow_dispatch", MANUAL_WORKER: worker,
          MANUAL_REF: ref, BEFORE_SHA: "", PR_BASE_SHA: "",
          GITHUB_OUTPUT: output, GITHUB_SHA: "not-read-for-manual" },
        encoding: "utf8",
      });
      return readFileSync(output, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const worker of ["remote-control-mcp-worker", "database-mcp-worker",
    "ima-mcp-worker", "raindrop-mcp-worker", "ssh-mcp-worker", "github-actions-mcp-worker"]) {
    const values = runManual(worker);
    assert.match(values, new RegExp("^apps=" + worker + "$", "m"));
    assert.match(values, new RegExp("^remote_control_changed=" +
      (worker === "remote-control-mcp-worker" ? "true" : "false") + "$", "m"));
    assert.match(values, new RegExp("^database_changed=" +
      (worker === "database-mcp-worker" ? "true" : "false") + "$", "m"));
  }
  assert.throws(() => runManual("missing-worker"), (error) => error.status !== 0);
  assert.throws(() => runManual("remote-control-mcp-worker", "refs/heads/feature"), (error) => error.status !== 0);
});

test("SSH release requires EdgeSSH D1, own DO and scoped key", () => {
  const worker = "ssh-mcp-worker";
  const source = JSON.parse(readFileSync(new URL("../apps/ssh-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(source.secrets?.required, ["MCP_ACCESS_TOKEN", "ENCRYPTION_KEY"]);
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "ENCRYPTION_KEY" }];
  const bindings = [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "ENCRYPTION_KEY", type: "secret_text" },
    { name: "EDGE_SSH_DB", type: "d1", id: "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94" },
    { name: "SSH_OPERATIONS", type: "durable_object_namespace", class_name: "SshOperationsDO" },
  ];
  const settings = { bindings, observability: { enabled: true, logs: { invocation_logs: true } } };
  assert.equal(verifyBindings(worker, settings, secrets), true);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: bindings.filter(b => b.name !== "SSH_OPERATIONS"),
  }, secrets), /SSH Durable Object/);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: bindings.filter(b => b.name !== "EDGE_SSH_DB"),
  }, secrets), /D1 binding/);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: [...bindings, { name: "EDGE_SSH_BROKER", type: "service" }],
  }, secrets), /legacy broker/);
  assert.throws(() => verifyBindings(worker, settings, secrets.slice(0, 1)), /Secret missing/);
});

test("manual release selects GitHub Environment directly from the allowlisted Worker name", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      name: ${{ inputs.worker }}"),
    "selected Worker must resolve the same-named GitHub Environment");
  assert.doesNotMatch(workflow, /WORKER_CONFIG_SCOPE/,
    "no duplicated manually configured Environment name marker");
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/,
    "only manually dispatched workflow can publish");
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/,
    "only main branch may publish");
  assert.match(workflow, /Stage selected Worker Secrets for every release/,
    "every selected Worker must stage required secret values before deploy");
});

test("manual release always syncs selected Worker Secrets from GitHub and never silently falls back", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const secretStart = workflow.indexOf("      - name: Stage selected Worker Secrets for every release");
  const variableStart = workflow.indexOf("      - name: Stage approved Worker variables", secretStart);
  assert.ok(secretStart > 0 && variableStart > secretStart);
  const secretStep = workflow.slice(secretStart, variableStart);
  assert.doesNotMatch(secretStep, /^\s*if:/m, "existing Workers must never skip Secret staging");
  for (const name of ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN", "IMA_API_KEY",
    "DATABASE_ENCRYPTION_KEY", "DATABASE_GITHUB_ACTIONS_TOKEN", "ENCRYPTION_KEY", "ACTIONS_GITHUB_DISPATCH_TOKENS"]) {
    assert.ok(secretStep.includes("secrets." + name), "GitHub must provide " + name);
  }
  assert.ok(secretStep.includes("vars.DATABASE_KEY_ID"),
    "Database key identifier must come from a GitHub Environment Variable");
  assert.equal(secretStep.includes("secrets.DATABASE_KEY_ID"), false,
    "Database key identifier is public metadata, not a GitHub Secret");
  assert.equal(secretStep.includes("secrets.DATABASE_CONFIG"), false,
    "releases must never restage the retired whole-catalog Secret");
  assert.equal(secretStep.includes("secrets.IMA_CLIENT_ID"), false,
    "IMA_CLIENT_ID must not be staged as a Secret");
  const variableStep = workflow.slice(variableStart,
    workflow.indexOf("      - name: Recheck current main inside acquired release lock", variableStart));
  assert.ok(variableStep.includes("vars.IMA_CLIENT_ID"),
    "IMA_CLIENT_ID must be provided by the GitHub Environment Variable");
  const deployStart = workflow.indexOf("      - name: Publish exactly selected Worker");
  const deployEnd = workflow.indexOf("      - name: Remove temporary deployment configuration", deployStart);
  assert.ok(deployStart > 0 && deployEnd > deployStart);
  const deployStep = workflow.slice(deployStart, deployEnd);
  assert.ok(deployStep.includes('test -s "$RUNNER_TEMP/mcp-worker-secrets.json"'),
    "do not allow publishing when staged Secrets are missing");
  assert.ok(deployStep.includes('deploy_args=(--secrets-file "$RUNNER_TEMP/mcp-worker-secrets.json")'),
    "must upload Secrets alongside every code deployment");
  assert.doesNotMatch(deployStep, /steps\.preflight\.outputs\.bootstrap/,
    "Secret upload must not be limited to bootstrap");
  assert.equal(workflow.includes("mcp-bootstrap-secrets.json"), false);
  assert.ok(workflow.includes('run: rm -f "$RUNNER_TEMP/mcp-worker-secrets.json"'),
    "temporary secret material must always be deleted");
});

test("Wrangler never preserves unmanaged dashboard Variables on any selected Worker", () => {
  for (const worker of ["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker",
    "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker"]) {
    const file = readFileSync(new URL("../apps/" + worker + "/wrangler.jsonc", import.meta.url), "utf8");
    assert.match(file, /"keep_vars": false/, worker);
  }
});

test("preflight allows GitHub to restore a missing runtime Secret, but readback fails closed", () => {
  const settings = {
    bindings: [{ name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" }],
    observability: { enabled: true, logs: { invocation_logs: true } },
  };
  assert.equal(verifyBindings("raindrop-mcp-worker", settings,
    [{ name: "RAINDROP_ACCESS_TOKEN" }], { mode: "preflight" }), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", settings,
    [{ name: "RAINDROP_ACCESS_TOKEN" }], { mode: "readback" }), /Required runtime Secret missing/);
  const filled = { ...settings, bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
  ] };
  assert.equal(verifyBindings("raindrop-mcp-worker", filled,
    [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }],
    { mode: "readback" }), true);
});


test("first GitHub Actions Worker release retries only transient 404s without weakening ingress check", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("      - name: Check unauthenticated MCP surface without credentials"));
  assert.match(step, /FIRST_DEPLOY: \$\{\{ steps\.preflight\.outputs\.bootstrap \}\}/);
  assert.match(step, /\[\[ "\$SELECTED_WORKER" == "github-actions-mcp-worker" && "\$FIRST_DEPLOY" == "true" \]\]/);
  assert.match(step, /max_attempts=1/);
  assert.match(step, /max_attempts=12/);
  assert.match(step, /401\|403\)/);
  assert.match(step, /404\)/);
  assert.match(step, /attempt < max_attempts/);
  assert.match(step, /Unexpected unauthenticated MCP status/);
});


test("GitHub Actions deploy requires only one PAT Secret and no repository lists", () => {
  const worker = "github-actions-mcp-worker";
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "ACTIONS_GITHUB_DISPATCH_TOKENS" }];
  const bindings = [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "ACTIONS_GITHUB_DISPATCH_TOKENS", type: "secret_text" },
  ];
  const settings = { bindings, observability: { enabled: true,
    logs: { invocation_logs: true } } };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...bindings, { name: "GITHUB_REPOS", type: "plain_text",
      text: "autoactions/tsrv" }],
  }, secrets, { mode: "readback" }), /Legacy GitHub Actions repository allowlists/);
  assert.throws(() => verifyBindings(worker, settings,
    [{ name: "MCP_ACCESS_TOKEN" }], { mode: "readback" }), /Required runtime Secret missing/);
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(release.includes("ACTIONS_GITHUB_DISPATCH_TOKENS: ${{ secrets.ACTIONS_GITHUB_DISPATCH_TOKENS }}"));
  assert.ok(!release.includes("GH_TOKEN: ${{ secrets.GH_TOKEN }}"));
  assert.ok(!release.includes("ACTIONS_MCP_TOKENS: ${{ secrets.ACTIONS_MCP_TOKENS }}"));
  assert.ok(!release.includes("MCP_BROKER_TOKEN: ${{ secrets.MCP_BROKER_TOKEN }}"));
  assert.ok(!release.includes("GH_TOKEN_SECONDARY"));
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...bindings, { name: "DANGEROUS_RESOURCE", type: "service" }] },
    secrets, { mode: "readback" }), /Unexpected production resource/);
});

test("Workflow production smoke SQL uses the currently reviewed D1 binding", () => {
  const source=JSON.parse(readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc",import.meta.url),"utf8"));
  const smoke=readFileSync(new URL("../apps/workflow-mcp-worker/tests/production-smoke.mjs",import.meta.url),"utf8");
  const target=source.d1_databases?.[0]?.database_name;
  assert.equal(target,"workflow-mcp-db");
  assert.ok(smoke.includes("'"+target+"', '--remote', '--json', '--command', statement"));
  assert.ok(!smoke.includes("'workflow-mcp-worker', '--remote', '--json', '--command', statement"));
});

test("Workflow production release must preserve exact reviewed resource and runtime boundaries", () => {
  const owner = JSON.parse(readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(verifyWorkflowReleaseConfig(owner), true);
  const brokenOwners = [
    [{ ...owner, routes: [{ pattern: "wrong.lirtual.dpdns.org", custom_domain: true }] }, /public route/],
    [{ ...owner, d1_databases: [{ ...owner.d1_databases[0], database_id: "00000000-0000-0000-0000-000000000000" }] }, /production D1/],
    [{ ...owner, services: [] }, /Service Binding/],
    [{ ...owner, services: [{binding:"UNEXPECTED",service:"fake"}] }, /Service Binding/],
    [{ ...owner, services: [{...owner.services[0],entrypoint:"UnreviewedEntrypoint"}] }, /Service Binding/],
    [{ ...owner, services: [...owner.services,{...owner.services[0],binding:"SECOND"}] }, /Service Binding/],
    [{ ...owner, workflows: [] }, /Workflow binding/],
    [{ ...owner, secrets: { required: [] } }, /Secret/],
    [{ ...owner, vars: { MCP_CALL_ENABLED: "true" } }, /MCP/],
    [{ ...owner, compatibility_flags: ["global_fetch_strictly_public"] }, /MCP/],
  ];
  for(const [cfg,err] of brokenOwners)assert.throws(()=>verifyWorkflowReleaseConfig(cfg),err);

});

test("Workflow remote D1 checks the exact old, intermediate and full schema", () => {
  const result = row => [{success:true,results:[row]}];
  const baseline = {
    migration_count:5,migration_v1:1,migration_v2:1,migration_v3:1,
    migration_v4:1,migration_v5:1,migration_v6:0,migration_v7:0,migration_v8:0,migration_v9:0,migration_v10:0,migration_v11:0,migration_v12:0,migration_v14:0,migration_v15:0,migration_v16:0,migration_v17:0,migration_v18:0,portal_auth_table:0,mcp_fence_table:0,http_auth_table:0,cloudflare_gate_table:0,deleted_column:0,event_receipts_table:0,runtime_table:0,approval_gates_table:0,approvals_table:0,
    capacity_column:0,parent_column:0,parent_step_column:0,child_index:0,child_cancel_table:0,
    child_terminate_fence_column:0,capacity_guard_trigger:0,
    locator_column:0,fixed_column:0,fixed_index:0,
    attempt_table:1,receipt_table:1,native_column:1,
    session_table:0,cancellation_table:0,
    active_runs:0,active_sessions:0,run_count:0,workflow_count:0,
  };
  const partial = {...baseline,migration_count:6,migration_v6:1};
  const current = {...partial,migration_count:7,migration_v7:1,
    session_table:1,cancellation_table:1};
  const completed = {...current,migration_count:8,migration_v8:1,locator_column:1};
  const oldComplete = {...completed,migration_count:9,migration_v9:1,fixed_column:1,fixed_index:1};
  const upgraded = {...oldComplete,migration_count:10,migration_v10:1,runtime_table:1};
  const previousComplete = {...upgraded,migration_count:11,migration_v11:1,
    capacity_column:1,parent_column:1,parent_step_column:1,child_index:1,child_cancel_table:1,
    child_terminate_fence_column:1,capacity_guard_trigger:1};
  const latest = {...previousComplete,migration_count:12,migration_v12:1,event_receipts_table:1};
  const cloudflareComplete = {...latest,migration_count:13,migration_v13:1,
    invocations_table:1,cloudflare_cancel_table:1};
  const deletedComplete = {...cloudflareComplete,migration_count:14,migration_v14:1,deleted_column:1};
  const approvalComplete={...deletedComplete,migration_count:15,migration_v15:1,approval_gates_table:1,approvals_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(baseline),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(partial),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(current),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(completed),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(oldComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(upgraded),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(previousComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(latest),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(cloudflareComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(deletedComplete),false),true);
  const portalComplete={...approvalComplete,migration_count:16,migration_v16:1,portal_auth_table:1,mcp_fence_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(approvalComplete),false),true);
  const httpComplete={...portalComplete,migration_count:17,migration_v17:1,http_auth_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(portalComplete),false),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(portalComplete),false,true),/schema migrations/);
  const actionsComplete={...httpComplete,migration_count:18,migration_v18:1,cloudflare_gate_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(httpComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(actionsComplete),false,true),true);
  for(const broken of [{migration_v16:0},{portal_auth_table:0},{mcp_fence_table:0},
    {migration_v17:0},{http_auth_table:0},{migration_v18:0},{cloudflare_gate_table:0},{migration_count:17}])
    assert.throws(()=>verifyWorkflowD1Readiness(result({...actionsComplete,...broken}),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(deletedComplete),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(cloudflareComplete),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(latest),false,true),/schema migrations/);
  for(const row of [
    {...cloudflareComplete,migration_count:12},
    {...cloudflareComplete,migration_v13:0},
    {...cloudflareComplete,invocations_table:0},
    {...cloudflareComplete,cloudflare_cancel_table:0},
    {...deletedComplete,migration_count:13},
    {...deletedComplete,migration_v14:0},
    {...deletedComplete,deleted_column:0},
    {...approvalComplete,migration_v15:0},
    {...approvalComplete,approval_gates_table:0},
    {...approvalComplete,approvals_table:0},
  ]) assert.throws(()=>verifyWorkflowD1Readiness(result(row),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(previousComplete),false,true),/schema migrations/);
  for(const row of [baseline,partial,current,completed,oldComplete,upgraded]){
    assert.throws(()=>verifyWorkflowD1Readiness(result(row),false,true),
      /schema migrations/);
  }
  for(const row of [
    {...baseline,migration_count:4,migration_v5:0},
    {...baseline,migration_count:6},
    {...partial,migration_v6:0},
    {...completed,migration_v4:0},
    {...completed,migration_v7:0},
    {...current,migration_count:8},
    {...completed,migration_v8:0},
    {...completed,locator_column:0},
    {...completed,session_table:0},
    {...completed,cancellation_table:0},
    {...completed,receipt_table:0},
    {...completed,migration_count:9},
    {...completed,migration_v9:1},
    {...oldComplete,migration_count:10},
    {...upgraded,migration_v10:0},
    {...upgraded,runtime_table:0},
    {...upgraded,migration_v11:1},
    {...latest,migration_count:10},
    {...latest,migration_count:11},
    {...latest,migration_v11:0},
    {...latest,migration_v12:0},
    {...latest,event_receipts_table:0},
    {...previousComplete,migration_v12:1},
    {...previousComplete,event_receipts_table:1},
    {...latest,capacity_column:0},
    {...latest,parent_column:0},
    {...latest,parent_step_column:0},
    {...latest,child_index:0},
    {...latest,child_cancel_table:0},
    {...latest,child_terminate_fence_column:0},
    {...latest,capacity_guard_trigger:0},
    {...upgraded,fixed_index:0},
    {...upgraded,fixed_column:0},
    {...completed,native_column:0},
  ]){
    assert.throws(()=>verifyWorkflowD1Readiness(result(row),false),
      /schema migrations/);
  }
  assert.equal(verifyWorkflowD1Readiness(result({...actionsComplete,run_count:3,
    workflow_count:1}),false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,active_runs:1}),false),
    /active or indeterminate/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...oldComplete,active_sessions:1}),false),
    /active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...completed,active_sessions:1}),false),
    /active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,active_sessions:1}),false),/active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...approvalComplete,active_sessions:1}),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...portalComplete,active_sessions:1}),false),/active physical Sessions/);
  assert.equal(verifyWorkflowD1Readiness(result({...actionsComplete,active_sessions:1}),false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,run_count:1}),true),
    /empty production/);
  assert.throws(()=>verifyWorkflowD1Readiness([],true),/readback unavailable/);
});
test("Workflow migration preflight requires all independent physical states settled", () => {
  const ready = {
    migration_count: 12, expected_migrations: 12,
    workflow_count: 7, run_count: 58, session_count: 49,
    attempt_count: 31, callback_count: 4, cancellation_count: 31,
    nonterminal_runs: 0, unresolved_starts: 0, unresolved_steps: 0, invalid_cancelled_steps: 0,
    nonterminal_attempts: 0, nonterminated_sessions: 0, undelivered_callbacks: 0,
  };
  const response = row => [{success: true, results: [row]}];
  assert.deepEqual(verifyWorkflowMigrationReadiness(response(ready)), {
    workflows: 7, runs: 58, sessions: 49, attempts: 31, callbacks: 4,
    cancellations: 31,
  });
  for (const name of [
    "nonterminal_runs","unresolved_starts","unresolved_steps","invalid_cancelled_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,[name]:1})), new RegExp(name));
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,[name]:-1})), /count unavailable or invalid/);
  }
  for (const key of Object.keys(ready)) {
    const broken = {...ready};
    delete broken[key];
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response(broken)), /count unavailable or invalid/);
  }
  for (const invalid of [[],[{}],[{success:false,results:[ready]}],
    [{success:true,results:[ready,ready]}]]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(invalid),
      /readback unavailable/);
  }
  for (const wrong of [{migration_count:9},{migration_count:11},
    {expected_migrations:11}]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,...wrong})), /exact reviewed/);
  }
  for (const invalid of [null,NaN,1.5,"0",true]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,undelivered_callbacks:invalid})),
      /count unavailable or invalid/);
  }
  for (const requiredTable of [
    "runs","run_steps","step_attempts","session_executions",
    "callback_receipts","github_action_cancellations","d1_migrations",
  ]) assert.ok(WORKFLOW_MIGRATION_READINESS_SQL.includes(requiredTable));
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/state != 'terminated'/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/notification_delivered != 1/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0012_event_wait_receipts.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0013_cloudflare_action_invocations.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0014_workflow_deletion.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0016_portal_connection_revocation.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0017_http_connection_auth.sql/);
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.equal((release.match(/AS migration_v17/g)??[]).length,2);
  assert.equal((release.match(/AS http_auth_table/g)??[]).length,2);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/invalid_cancelled_steps/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/reviewed_terminal_artifact_attempts/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0 AS reviewed_terminal_artifact_attempts/);

});

test("Task-only production acceptance reuses confirmed Ready Session gate and scoped cleanup",()=>{
  const source=readFileSync(new URL("../apps/workflow-mcp-worker/tests/production-smoke.mjs",import.meta.url),"utf8");
  const fn=source.slice(source.indexOf("async function runActionTaskSmoke()"),
    source.indexOf("async function runWebhookSmoke()"));
  assert.match(fn,/verifyWorkflowCodeReleaseReadiness\(\[\{/);
  assert.match(fn,/sql\(WORKFLOW_MIGRATION_READINESS_SQL\)/);
  assert.doesNotMatch(fn,/session_executions WHERE state != 'terminated'/);
  assert.match(source,/DELETE FROM step_attempts WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/DELETE FROM mcp_dispatch_fences WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/Refusing GitHub cleanup until physical GitHub Job is completed/);
});

test('cancelled Workflow Steps count as terminal only with matched cancelled Run receipt',()=>{
  const start=WORKFLOW_MIGRATION_READINESS_SQL.indexOf('(SELECT count(*) FROM run_steps s JOIN runs r');
  const end=WORKFLOW_MIGRATION_READINESS_SQL.indexOf(' AS invalid_cancelled_steps',start);
  assert.ok(start>=0&&end>start);
  const query='SELECT '+WORKFLOW_MIGRATION_READINESS_SQL.slice(start,end+ ' AS invalid_cancelled_steps'.length);
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT,error_code TEXT);');
    db.exec('CREATE TABLE run_steps(run_id TEXT,status TEXT,error_code TEXT);');
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run('r','cancelled','approval_cancel_requested');
    db.prepare('INSERT INTO run_steps VALUES(?,?,?)').run('r','cancelled','approval_cancel_requested');
    const count=()=>db.prepare(query).get()?.invalid_cancelled_steps;
    assert.equal(count(),0);
    db.exec("UPDATE runs SET outcome='running'");assert.equal(count(),1);
    db.exec("UPDATE runs SET outcome='cancelled',error_code=NULL");assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='approval_cancel_requested';UPDATE run_steps SET error_code=NULL");assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='approval_cancel_requested'");assert.equal(count(),0);
    // Event Wait cancellation is a separate supported, durable Run/Step pair.
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested';UPDATE run_steps SET error_code='event_wait_cancel_requested'");
    assert.equal(count(),0);
    db.exec("UPDATE run_steps SET error_code='approval_cancel_requested'");assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='event_wait_cancel_requested';UPDATE runs SET error_code='unknown_cancel_requested'");
    assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested';UPDATE run_steps SET error_code=NULL");
    assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='event_wait_cancel_requested';UPDATE runs SET error_code=NULL");
    assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested'");assert.equal(count(),0);
  }finally{db.close();}
});

test("code-only release admits only confirmed Ready Sessions, not migrations",()=>{
  const row={
    migration_count:18,expected_migrations:18,
    nonterminal_runs:0,unresolved_starts:0,unresolved_steps:0,invalid_cancelled_steps:0,
    nonterminal_attempts:1,nonterminated_sessions:1,
    undelivered_callbacks:0,confirmed_ready_sessions:1,reviewed_terminal_artifact_attempts:0,verified_terminal_saga_receipts:0,
  };
  const make=value=>[{success:true,results:[value]}];
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make(row)),
    {confirmed_ready_sessions:1});
  assert.throws(()=>verifyWorkflowMigrationReadiness(make({
    ...row,workflow_count:5,run_count:53,session_count:1,
    attempt_count:10,callback_count:1,cancellation_count:0,
  })),/nonterminal_attempts/);
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make({
    ...row,nonterminal_attempts:0,nonterminated_sessions:0,confirmed_ready_sessions:0,
  })),{confirmed_ready_sessions:0});
  const historical={...row,nonterminal_attempts:2,reviewed_terminal_artifact_attempts:1};
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make(historical),true),
    {confirmed_ready_sessions:1});
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make(historical)),/unconfirmed/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,nonterminal_attempts:3,
  }),true),/unconfirmed/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,reviewed_terminal_artifact_attempts:0,
  }),true),/historical Artifact/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,reviewed_terminal_artifact_attempts:2,
  }),true),/historical Artifact/);
  // Code-only publish can proceed when every remaining unresolved record
  // is an exact Saga request whose Session and GitHub Attempt both have
  // verified physical terminal evidence. Schema migrations stay strict.
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make({
    ...row,nonterminal_attempts:0,nonterminated_sessions:0,confirmed_ready_sessions:0,
    unresolved_steps:1,verified_terminal_saga_receipts:1,
  })),{confirmed_ready_sessions:0});
  for(const broken of [
    {migration_count:12},{expected_migrations:12},
    {migration_count:13},{expected_migrations:13},
    {migration_count:14},{expected_migrations:14},
    {nonterminal_runs:1},{unresolved_starts:1},{unresolved_steps:1},{invalid_cancelled_steps:1},
    {unresolved_steps:2,verified_terminal_saga_receipts:1},
    {verified_terminal_saga_receipts:1},{verified_terminal_saga_receipts:-1},
    {verified_terminal_saga_receipts:'1'},{verified_terminal_saga_receipts:undefined},
    {undelivered_callbacks:1},{nonterminal_attempts:2},
    {nonterminated_sessions:2},{confirmed_ready_sessions:0},
    {confirmed_ready_sessions:-1},{confirmed_ready_sessions:"1"},
  ]) assert.throws(()=>verifyWorkflowCodeReleaseReadiness(
    make({...row,...broken})),/blocked|unavailable/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness([]),/readback unavailable/);
});

test('code-only gate proves terminal Saga receipts using exact physical Session and Attempt',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT);
      CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT);
      CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
      CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,capability_id TEXT,state TEXT);
      INSERT INTO runs VALUES('r','failed');
      INSERT INTO run_steps VALUES('r','__saga_ubuntu','requested');
      INSERT INTO session_executions VALUES('r','ubuntu','terminated');
      INSERT INTO step_attempts VALUES('r','ubuntu','github.action','cancelled');`);
    const begin=WORKFLOW_MIGRATION_READINESS_SQL.indexOf('(SELECT count(*) FROM run_steps receipt');
    const end=WORKFLOW_MIGRATION_READINESS_SQL.indexOf(' AS verified_terminal_saga_receipts',begin);
    assert.ok(begin>=0&&end>begin);
    const query='SELECT '+WORKFLOW_MIGRATION_READINESS_SQL.slice(begin,end+ ' AS verified_terminal_saga_receipts'.length);
    const count=()=>db.prepare(query).get()?.verified_terminal_saga_receipts;
    assert.equal(count(),1);
    db.exec("UPDATE step_attempts SET state='claimed'");
    assert.equal(count(),0,'claimed Job is never physical terminal');
    db.exec("UPDATE step_attempts SET state='cancelled'; UPDATE session_executions SET state='stopping'");
    assert.equal(count(),0,'cancel ACK cannot substitute physical Session terminal');
    db.exec("UPDATE session_executions SET state='terminated';UPDATE runs SET outcome='running'");
    assert.equal(count(),0,'parent must have a terminal business outcome');
    db.exec("UPDATE runs SET outcome='failed';UPDATE run_steps SET step_id='other'");
    assert.equal(count(),0,'non-Saga Step cannot be accepted');
  }finally{db.close();}
});

test("Workflow readback verifies one integrated runtime, GitHub Action audience and Portal",()=>{
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"SESSION_RUNTIME_DATA_KEY",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"ACTIONS_DEPLOYMENT_ID",type:"plain_text",text:"33333333-3333-4333-8333-333333333333"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action:production"},
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN","SESSION_RUNTIME_DATA_KEY"].map(name=>({name}));
  const check=(list=bindings,ss=secrets)=>
    verifyBindings("workflow-mcp-worker",{...settings,bindings:list},ss,{mode:"readback"});
  assert.equal(check(),true);
  assert.throws(()=>check([...bindings,{name:"WEIXIN_ACTION_PROVIDER",type:"service",service:"weixin-mcp-worker"}]),
    /Unexpected production resource binding/);
  assert.throws(()=>check(bindings.map(x=>x.name==="ACTIONS"?{...x,entrypoint:"UnexpectedEntrypoint"}:x)),
    /Service Binding/);
  assert.throws(()=>check(bindings.filter(x=>x.name!=="ACTIONS_DEPLOYMENT_ID")),/Provider Version ID/);
  assert.throws(()=>check(bindings.map(x=>x.name==="ACTIONS_DEPLOYMENT_ID"?{...x,text:"latest"}:x)),/Provider Version ID/);
  assert.throws(()=>check([...bindings,{name:"WORKFLOW_LEGACY",type:"workflow",workflow_name:"workflow-mcp-runner",class_name:"WorkflowRunner"}]),/Unexpected production resource binding/);
  assert.throws(()=>check(bindings.filter(x=>x.name!=="GITHUB_ACTION_OIDC_AUDIENCE")),
    /Action OIDC audience/);
  assert.throws(()=>check(bindings.map(x=>x.name==="GITHUB_ACTION_OIDC_AUDIENCE"
    ? {...x,text:"workflow-github-action:staging"} : x)),/Action OIDC audience/);
  for(const name of ["DB","WORKFLOW"]){
    assert.throws(()=>check(bindings.filter(x=>x.name!==name)),/binding drift/);
  }
  for(const name of ["MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN","SESSION_RUNTIME_DATA_KEY"]){
    assert.throws(()=>check(bindings,secrets.filter(x=>x.name!==name)),/Secret missing/);
  }
  assert.throws(()=>check(bindings.map(x=>x.name==="MCP_PORTAL_CLIENT_ID" ?
    {...x,type:"secret_text"}:x)),/plaintext Variable/);
  assert.throws(()=>check([...bindings,{name:"MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"duplicate"}]),
    /plaintext Variable/);
  assert.throws(()=>check([...bindings,{name:"MCP_PORTAL_CLIENT_ID",type:"secret_text"}]),
    /plaintext Variable/);
  assert.throws(()=>check(bindings,[...secrets,{name:"MCP_PORTAL_CLIENT_ID"}]),
    /plaintext Variable/);
  assert.throws(()=>check([...bindings,{name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}]),/Obsolete stage flag/);
});


test("Workflow manual GitHub Actions requires D1 checks before Owner", () => {
  const ci=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  const pre=ci.indexOf("      - name: Verify Workflow release configuration and remote D1 readiness");
  const migration=ci.indexOf("      - name: Apply complete Workflow D1 migrations");
  const publish=ci.indexOf("      - name: Publish exactly selected Worker");
  assert.ok(pre>0 && migration>pre && publish>migration);
  assert.match(ci,/wrangler d1 migrations apply workflow-mcp-db --remote/);
  const finalQuiescence=ci.indexOf("      - name: Verify code-only Workflow D1 gate at publication (Ready Sessions preserved)");
  assert.ok(finalQuiescence>migration && finalQuiescence<publish);
  const pin=ci.indexOf("      - name: Pin the reviewed unified Actions Worker (read-only)");
  const recheck=ci.indexOf("      - name: Recheck unified Actions Worker before Workflow publication (read-only)");
  const freeze=ci.indexOf("      - name: Verify unified Actions binding transition (read-only)");
  assert.ok(pin>0 && recheck>pin && freeze>recheck && freeze<publish);
  assert.match(ci,/node scripts\/actions-consumer-cutover-gate\.mjs/);
  assert.equal(ci.split('0018_cloudflare_action_migration_fence.sql').length,3);
  assert.match(ci,/pnpm exec wrangler d1 execute workflow-mcp-db --remote --json --command "\$query"/);

  for(const name of ["0006_action_attempt_capabilities.sql","0007_session_executions.sql","0009_fixed_sessions.sql","0010_session_runtime_data.sql","0011_awaited_child_capacity.sql"]){
    assert.equal(ci.split(name).length,3);
  }
  assert.ok(ci.includes("GITHUB_ACTION_APPROVED_REPOSITORIES: " + String.fromCharCode(36) + "{{ vars.WORKFLOW_ACTION_APPROVED_REPOSITORIES }}"));
  assert.ok(!ci.includes("vars.GITHUB_ACTION_APPROVED_REPOSITORIES"));
  assert.match(ci,/WORKFLOW_REQUIRE_COMPLETE_SCHEMA: 'true'/);
  assert.ok(ci.includes("WORKFLOW_FIRST_DEPLOY: " + String.fromCharCode(36) + "{{ steps.preflight.outputs.bootstrap }}"));
  assert.match(ci,/node scripts\/manual-worker-release\.mjs d1-check workflow-mcp-worker/);
  assert.match(ci,/\(cd apps\/workflow-mcp-worker &&/);
  assert.match(ci,/mcp_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/mcp"/);
  assert.match(ci,/health_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/health"/);
  assert.match(ci,/body\.scope !== "workflow"/);
  assert.match(ci,/github\.ref == 'refs\/heads\/main'/);
});

test("Workflow release pins the exact Portal and rejects target drift",()=>{
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},{name:"MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},{name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"SESSION_RUNTIME_DATA_KEY",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"ACTIONS_DEPLOYMENT_ID",type:"plain_text",text:"33333333-3333-4333-8333-333333333333"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action:production"},
  ];
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN","SESSION_RUNTIME_DATA_KEY"].map(name=>({name}));
  const check=(updated)=>verifyBindings("workflow-mcp-worker",{...settings,bindings:updated},secrets,{mode:"readback"});
  assert.equal(check(bindings),true);
  assert.throws(()=>check(bindings.map(x=>x.name==="MCP_PORTAL_ENDPOINT"
    ?{...x,text:"https://retired.example.org/mcp"}:x)),/pinned Workflow MCP Portal|Pinned Workflow MCP Portal/);
  assert.throws(()=>check([...bindings,{name:"MCP_DIRECT_TARGETS_ENABLED",type:"plain_text",text:"true"}]),
    /Obsolete stage flag/);
});


test("Workflow production readback rejects retired fixed executor pins",()=>{
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"SESSION_RUNTIME_DATA_KEY",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"ACTIONS_DEPLOYMENT_ID",type:"plain_text",text:"33333333-3333-4333-8333-333333333333"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action:production"},
  ];
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN","SESSION_RUNTIME_DATA_KEY"].map(name=>({name}));
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const verify=list=>verifyBindings("workflow-mcp-worker",{...settings,bindings:list},secrets,{mode:"readback"});
  assert.equal(verify(bindings),true);
  for(const name of ["GITHUB_EXECUTOR_REPOSITORY","GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF","GITHUB_EXECUTOR_AUDIENCE"])
    assert.throws(()=>verify([...bindings,{name,type:"plain_text",text:"obsolete"}]),/Retired fixed GitHub executor variables/);
});

test("Workflow preflight tolerates removed service bindings, readback rejects them",()=>{
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN","SESSION_RUNTIME_DATA_KEY"].map(name=>({name}));
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"SESSION_RUNTIME_DATA_KEY",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-s1",class_name:"WorkflowOrchestrator"},
    {name:"OLD_TEST_SERVICE",type:"service",service:"unused-test-worker"},
    {name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  assert.equal(verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"preflight"}),true);
  assert.throws(()=>verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"readback"}),/Workflow native Workflow binding drift/);
});


test("HTTP release only allows strict-public source and exact optional credential Secret inventory", () => {
  const base = {bindings:[{name:"MCP_ACCESS_TOKEN",type:"secret_text"}],
    observability:{enabled:true,logs:{invocation_logs:true}}};
  const required=[{name:"MCP_ACCESS_TOKEN"}];
  assert.equal(verifyBindings("http-mcp-worker",base,required,
    {mode:"preflight",expectedHttpCredentials:false}),true);
  assert.equal(verifyBindings("http-mcp-worker",base,required,
    {mode:"readback",expectedHttpCredentials:false}),true);
  const withSecret={...base,bindings:[...base.bindings,{name:"HTTP_CREDENTIALS_JSON",type:"secret_text"}]};
  assert.throws(()=>verifyBindings("http-mcp-worker",withSecret,
    [...required,{name:"HTTP_CREDENTIALS_JSON"}],{mode:"preflight",expectedHttpCredentials:false}),
    /Stale HTTP_CREDENTIALS_JSON/);
  assert.equal(verifyBindings("http-mcp-worker",withSecret,
    [...required,{name:"HTTP_CREDENTIALS_JSON"}],{mode:"readback",expectedHttpCredentials:true}),true);
  assert.throws(()=>verifyBindings("http-mcp-worker",base,required,
    {mode:"readback",expectedHttpCredentials:true}),/binding inventory drift/);
  const cfg=JSON.parse(readFileSync(new URL("../apps/http-mcp-worker/wrangler.jsonc",import.meta.url),"utf8"));
  assert.deepEqual(cfg.compatibility_flags,["global_fetch_strictly_public"]);
  assert.deepEqual(cfg.secrets.required,["MCP_ACCESS_TOKEN"]);
  assert.equal(cfg.keep_vars,false);
  const release=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  assert.match(release,/http-mcp-worker/);
  assert.match(release,/HTTP_CREDENTIALS_JSON/);
});

test("HTTP readback tolerates only bounded optional Secret inventory propagation",async()=>{
 let attempts=0;
 const result=await retryReleaseReadback(async()=>{
   attempts++;
   if(attempts===1)throw Error("Optional HTTP_CREDENTIALS_JSON binding inventory drift");
   return {version_id:"new-version"};
 },async()=>{});
 assert.equal(attempts,2);
 assert.deepEqual(result,{version_id:"new-version"});
});

test("worker release documentation stays aligned with the selected-Worker contract", async () => {
  const { BOOTSTRAP_SECRETS } = await import("./bootstrap-worker-secrets.mjs");
  const { WORKER_VARIABLES } = await import("./worker-release-variables.mjs");
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const options = release.match(/\n\s+options:\n([\s\S]*?)\n\s+[a-z][a-z_]+:/);
  assert.ok(options, "missing worker release choice options");
  const selected = [...options[1].matchAll(/^\s+- ([a-z-]+-mcp-worker)$/gm)].map(m => m[1]).sort();
  const { RELEASE_WORKERS } = await import("./select-affected-apps.mjs");
  assert.deepEqual(selected, [...RELEASE_WORKERS].sort());
  assert.ok(selected.every(worker => Object.hasOwn(BOOTSTRAP_SECRETS, worker)));
  assert.ok(selected.every(worker => Object.hasOwn(WORKER_VARIABLES, worker)));

  for (const path of ["../docs/MANUAL-WORKER-BOOTSTRAP.md",
    "../docs/runtime-configuration.md", "../docs/mcp-shared-token-runbook.md",
    "../docs/ingress-policy.md"]) {
    const doc = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const worker of selected) assert.ok(doc.includes("`" + worker + "`"), path + " omits " + worker);
  }
  const bootstrap = readFileSync(new URL("../docs/MANUAL-WORKER-BOOTSTRAP.md", import.meta.url), "utf8");
  for (const [worker, secrets] of Object.entries(BOOTSTRAP_SECRETS)) {
    const row = bootstrap.split("\n").find(line => line.startsWith("| `" + worker + "` |"));
    assert.ok(row, "missing Worker Environment row for " + worker);
    for (const secret of secrets.filter(x => x !== "MCP_ACCESS_TOKEN"))
      assert.ok(row.includes("`" + secret + "`"), worker + " docs omit " + secret);
  }
  const actions = readFileSync(new URL("../apps/github-actions-mcp-worker/README.md", import.meta.url), "utf8");
  assert.match(actions, /"worker":"github-actions-mcp-worker","deploy_to_production":"true"/);
  assert.doesNotMatch(actions, /"worker":"remote-control-mcp-worker"/);
  const imaConfig = JSON.parse(readFileSync(new URL("../apps/ima-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(!imaConfig.secrets.required.includes("IMA_CLIENT_ID"));
  for (const path of ["../apps/ima-mcp-worker/README.md",
    "../apps/ima-mcp-worker/DEPLOY_CLOUDFLARE.md", "../apps/ima-mcp-worker/docs/mcp-portal.md"]) {
    const doc = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(doc, /IMA_CLIENT_ID/);
    assert.match(doc, /Variable/);
    assert.doesNotMatch(doc, /Worker Secrets:.*IMA_CLIENT_ID/);
  }
  const ingress = readFileSync(new URL("../docs/ingress-policy.md", import.meta.url), "utf8");
  for (const worker of ["workflow-mcp-worker"])
    assert.match(ingress, new RegExp(worker));
  assert.match(ingress, /workers_dev: false/);
});

test("Database Hyperdrive mapping requires exactly matching unique Wrangler IDs", () => {
  const manifest = [{ binding: "HYPERDRIVE_APP", id: "11111111-2222-3333-4444-555555555555" }];
  assert.equal(verifyDatabaseHyperdriveSource({ hyperdrive: [...manifest] }, manifest), true);
  assert.throws(() => verifyDatabaseHyperdriveSource({ hyperdrive: manifest }, []), /manifest\/source mismatch/);
  assert.throws(() => verifyDatabaseHyperdriveSource({ hyperdrive: [...manifest, { ...manifest[0], binding: "HYPERDRIVE_OTHER" }] },
    [...manifest, { ...manifest[0], binding: "HYPERDRIVE_OTHER" }]), /not uniquely/);
});

test("Database Hyperdrive config readback is fail-closed before and after release", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const before = workflow.indexOf("Verify Database Hyperdrive TLS, CA, origin and cache before publication");
  const publish = workflow.indexOf("Publish exactly selected Worker");
  const after = workflow.indexOf("Verify Database Hyperdrive TLS, CA, origin and cache after publication");
  assert.ok(before > 0 && before < publish && after > publish);
  for (const name of [
    "Verify Database Hyperdrive TLS, CA, origin and cache before publication",
    "Verify Database Hyperdrive TLS, CA, origin and cache after publication"
  ]) {
    const section = workflow.slice(workflow.indexOf("- name: " + name), workflow.indexOf("run: node scripts/verify-database-hyperdrive.mjs", workflow.indexOf("- name: " + name)) + 55);
    assert.match(section, /if: inputs.worker == 'database-mcp-worker'/);
    assert.match(section, /CLOUDFLARE_API_TOKEN/);
  }
});

test('Browser release pins resources, protects namespace and stages only its independent Bearer', async()=>{
  const worker='browser-mcp-worker';
  const source=readFileSync(new URL('../apps/browser-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
  const conf=readConfiguration(worker,source);
  const settings={bindings:[{name:'MCP_ACCESS_TOKEN',type:'secret_text'},
    {name:'BROWSER_OWNER',type:'durable_object_namespace',class_name:'BrowserOwner',namespace_id:'browser-original'},
    {name:'ASSETS',type:'assets'}],
    observability:{enabled:true,logs:{invocation_logs:false,head_sampling_rate:0}}};
  const secrets=[{name:'MCP_ACCESS_TOKEN'}];
  const options={mode:'readback',browserNamespaceId:'browser-original'};
  assert.equal(verifyBindings(worker,settings,secrets,options),true);
  const withoutAssets={...settings,bindings:settings.bindings.filter(b=>b.name!=="ASSETS")};
  assert.equal(verifyBindings(worker,withoutAssets,secrets,{...options,mode:"preflight"}),true,
    "currently deployed Worker has no public Assets binding yet");
  assert.throws(()=>verifyBindings(worker,withoutAssets,secrets,options),/Assets binding missing/,
    "post-deploy readback must require the public binding");
  assert.throws(()=>verifyBindings(worker,{...settings,bindings:[...withoutAssets.bindings,{name:"ASSETS",type:"service"}]},secrets,options),/Assets binding missing/);
  assert.throws(()=>readConfiguration(worker,JSON.stringify({...conf,assets:{...conf.assets,run_worker_first:false}})),/persistence drift/);
  assert.throws(()=>verifyBindings(worker,settings,[],options),/Secret missing/);
  assert.throws(()=>verifyBindings(worker,settings,secrets,{...options,browserNamespaceId:'different'}),/namespace changed/);
  for(const binding of [{name:'DB',type:'d1'}, {name:'MCP_ACCESS_TOKEN',type:'plain_text',text:'invalid'}])
    assert.throws(()=>verifyBindings(worker,{...settings,bindings:[...settings.bindings,binding]},secrets,options),/inventory drift/);
  assert.throws(()=>readConfiguration(worker,JSON.stringify({...conf,migrations:[]})),/persistence drift/);
  assert.throws(()=>readConfiguration(worker,JSON.stringify({...conf,durable_objects:{bindings:[{name:'BROWSER_OWNER',class_name:'Other'}]}})),/persistence drift/);
  const {collectBootstrapSecrets}=await import('./bootstrap-worker-secrets.mjs');
  assert.deepEqual(collectBootstrapSecrets(worker,{MCP_ACCESS_TOKEN:'independent',RAINDROP_ACCESS_TOKEN:'ignore'}),{MCP_ACCESS_TOKEN:'independent'});
  assert.throws(()=>collectBootstrapSecrets(worker,{}),/MCP_ACCESS_TOKEN/);
  const {collectWorkerVars}=await import('./worker-release-variables.mjs');
  assert.deepEqual(collectWorkerVars(worker,{MANIFEST_KEY:'public-not-a-secret'}),[]);
  const approve={BROWSER_APPROVAL_ORIGIN:'https://browser.lirtual.dpdns.org',
    BROWSER_ACCESS_ISSUER:'https://lirtualzero.cloudflareaccess.com',
    BROWSER_ACCESS_AUDIENCE:'a'.repeat(64),BROWSER_OWNER_EMAIL:'lirtual@outlook.com',
    BROWSER_APPROVAL_ISOLATION:'isolated-owner-profile-and-mailbox-v1'};
  const enabled={...settings,bindings:[...settings.bindings,
    ...Object.entries(approve).map(([name,text])=>({name,type:'plain_text',text}))]};
  assert.equal(verifyBindings(worker,enabled,secrets,{...options,expectedBrowserApproval:true}),true);
  const activation={BROWSER_ACTIVATION_ORIGIN:'https://browser.lirtual.dpdns.org',
    BROWSER_ACTIVATION_AUDIENCE:'b'.repeat(64)};
  const both={...enabled,bindings:[...enabled.bindings,
    ...Object.entries(activation).map(([name,text])=>({name,type:'plain_text',text}))]};
  const expectedBoth={...options,expectedBrowserApproval:true,
    expectedBrowserActivationAudience:activation.BROWSER_ACTIVATION_AUDIENCE};
  assert.equal(verifyBindings(worker,both,secrets,expectedBoth),true);
  assert.equal(verifyBindings(worker,both,secrets,{mode:'preflight'}),true);
  assert.throws(()=>verifyBindings(worker,both,secrets,{...options,expectedBrowserApproval:true}),
    /activation binding inventory differs/);
  assert.throws(()=>verifyBindings(worker,both,secrets,{...expectedBoth,
    expectedBrowserActivationAudience:'c'.repeat(64)}),/activation binding inventory differs/);
  assert.throws(()=>verifyBindings(worker,{...both,bindings:both.bindings.filter(x=>
    x.name!=='BROWSER_ACTIVATION_ORIGIN')},secrets,expectedBoth),/activation binding inventory incomplete/);
  assert.throws(()=>verifyBindings(worker,{...both,bindings:both.bindings.map(x=>
    x.name==='BROWSER_ACTIVATION_ORIGIN'?{...x,text:'https://wrong.example'}:x)},
    secrets,expectedBoth),/activation Access origin/);
  assert.throws(()=>verifyBindings(worker,{...both,bindings:[...both.bindings,
    {name:'OTHER_VAR',type:'plain_text',text:'bad'}]},secrets,expectedBoth),/inventory drift/);
  const temporaryOnly={...settings,bindings:[...settings.bindings,
    ...Object.entries(Object.fromEntries(Object.entries(approve).filter(([name])=>
      ['BROWSER_ACCESS_ISSUER','BROWSER_OWNER_EMAIL'].includes(name)))).map(([name,text])=>({name,type:'plain_text',text})),
    ...Object.entries(activation).map(([name,text])=>({name,type:'plain_text',text}))]};
  assert.equal(verifyBindings(worker,temporaryOnly,secrets,{
    ...options,expectedBrowserActivationAudience:activation.BROWSER_ACTIVATION_AUDIENCE}),true);
  assert.match(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8'),
    /BROWSER_ACTIVATION_EXPECTED:/);

  assert.throws(()=>verifyBindings(worker,enabled,secrets,options),/differs from reviewed/);
  assert.throws(()=>verifyBindings(worker,settings,secrets,{...options,expectedBrowserApproval:true}),/differs from reviewed/);
  assert.throws(()=>verifyBindings(worker,{...enabled,bindings:enabled.bindings.slice(0,-1)},secrets,options),/incomplete/);
  assert.throws(()=>verifyBindings(worker,{...enabled,bindings:enabled.bindings.map(b=>b.name==='BROWSER_OWNER_EMAIL'?{...b,text:'bad@example.com'}:b)},secrets,options),/identity/);
  assert.throws(()=>verifyBindings(worker,{...enabled,bindings:[...enabled.bindings,{name:'BAD_VAR',type:'plain_text',text:'no'}]},secrets,{...options,expectedBrowserApproval:true}),/inventory drift/);
  const workflow=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.match(workflow,/name: Build and verify shared Browser extension artifact\n        if: inputs.worker == 'browser-mcp-worker'/);
  assert.match(workflow,/mcp_endpoint="https:\/\/browser.lirtual.dpdns.org\/mcp"/);
  assert.match(workflow,/name: Register production Browser MCP with existing One-MCP Portal\n        if: inputs.worker == 'browser-mcp-worker'/);
  assert.match(workflow,/run: node scripts\/register-browser-portal\.mjs/);
});
