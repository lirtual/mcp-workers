import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildToolConfigs } from "../src/tools/index.js";
import { ToolEnvelopeSchema } from "../src/tools/common.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

/**
 * T01 (#128): immutable v3-to-v4 design baseline, not v4 registration.
 * A read action points to exactly one existing v3 handler. All mutating
 * operations remain independently discoverable in v4 (ADR-0001/0002).
 */
export const V4_READ_ACTION_BASELINE = {
  raindrop_read: {
    list: "raindrop_list",
    get: "raindrop_get",
    suggest: "raindrop_suggest",
  },
  collection_read: {
    list: "collection_list",
    tree: "collection_tree",
    get: "collection_get",
  },
  tag_read: { list: "tag_list" },
  highlight_read: { list: "highlight_list" },
  audit_read: { check: "library_audit" },
  diagnostics_read: { local: "diagnostics", upstream: "diagnostics" },
} as const;

export const V4_INDEPENDENT_MUTATION_BASELINE = [
  "raindrop_create",
  "raindrop_update",
  "raindrop_delete",
  "raindrop_bulk_update",
  "raindrop_bulk_delete",
  "collection_create",
  "collection_update",
  "collection_delete",
  "tag_rename",
  "tag_merge",
  "tag_delete",
  "highlight_create",
  "highlight_update",
  "highlight_delete",
  "duplicates_delete",
  "trash_empty",
] as const;

type AnnotationContract = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type BudgetContract = {
  nominal: string;
  maximum: string;
  counting: "Every submitted upstream fetch attempt, including read retries; validation, previews without reads, and gated failures before submission count zero";
};

type V3ToolContract = {
  v3Tool: string;
  v4: { target: string; action: string };
  schema: { input: string; output: "ToolEnvelopeSchema" };
  tests: readonly string[];
  upstream: readonly string[];
  budget: BudgetContract;
  scope: string;
  errors: readonly string[];
  annotations: AnnotationContract;
  featureGate:
    | "none"
    | "parent-null-disabled"
    | "duplicate-execution-disabled"
    | "pro-entitlement-runtime";
};

const COUNTING =
  "Every submitted upstream fetch attempt, including read retries; validation, previews without reads, and gated failures before submission count zero" as const;
const envelope = (tool: string) => ({
  input: `buildToolConfigs:${tool}.inputSchema`,
  output: "ToolEnvelopeSchema" as const,
});
const read = { readOnlyHint: true, openWorldHint: true } as const;
const localRead = { readOnlyHint: true } as const;
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const budget = (nominal: string, maximum: string): BudgetContract => ({
  nominal,
  maximum,
  counting: COUNTING,
});
const commonErrors = [
  "VALIDATION_ERROR",
  "AUTH_ERROR",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "UPSTREAM_REJECTED",
  "NOT_FOUND",
  "RESPONSE_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;
const writeErrors = [...commonErrors, "WRITE_OUTCOME_UNKNOWN"] as const;
const knownErrorCodes = new Set<string>([
  ...writeErrors,
  "RESOURCE_LIMIT",
  "FEATURE_UNAVAILABLE",
  "FEATURE_UNVERIFIED",
  "SCOPE_CHANGED",
]);
const EXPECTED_CONTRACT_SHA256 =
  "59d96a10d41e042d2d70bd8cc77af32b009af45c1f0937258b87ba84df67f362";

/**
 * Executable T01 migration contract. Every source tool owns one row. The
 * schema reference resolves to the actual v3 ToolConfig below; output always
 * resolves to ToolEnvelopeSchema. Request maxima include at most three retries
 * per GET and the request-local hard ceiling of 20 attempts; submitted writes
 * are never retried.
 */
export const V3_TOOL_CONTRACT_MATRIX: readonly V3ToolContract[] = [
  {
    v3Tool: "diagnostics",
    v4: { target: "diagnostics_read", action: "local|upstream" },
    schema: envelope("diagnostics"),
    tests: ["diagnostics_contract.test.ts"],
    upstream: ["local: none", "upstream: GET /user/stats"],
    budget: budget(
      "local=0; includeUpstream=true=1",
      "local=0; upstream<=4; request cap=20",
    ),
    scope: "request-local metadata; optional account statistics",
    errors: commonErrors,
    annotations: localRead,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_list",
    v4: { target: "raindrop_read", action: "list" },
    schema: envelope("raindrop_list"),
    tests: ["v3_bookmark_contract.test.ts"],
    upstream: ["GET /raindrops/{collectionId}"],
    budget: budget("1", "<=4; request cap=20"),
    scope: "one explicit collection/system collection, one page",
    errors: commonErrors,
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_get",
    v4: { target: "raindrop_read", action: "get" },
    schema: envelope("raindrop_get"),
    tests: ["v3_bookmark_contract.test.ts"],
    upstream: ["GET /raindrop/{id}"],
    budget: budget("1", "<=4; request cap=20"),
    scope: "one positive bookmark ID",
    errors: commonErrors,
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_create",
    v4: { target: "raindrop_create", action: "execute" },
    schema: envelope("raindrop_create"),
    tests: ["v3_bookmark_contract.test.ts"],
    upstream: ["POST /raindrop"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one new bookmark; allowlisted fields only",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_update",
    v4: { target: "raindrop_update", action: "execute" },
    schema: envelope("raindrop_update"),
    tests: ["v3_bookmark_contract.test.ts"],
    upstream: ["PUT /raindrop/{id}"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one positive bookmark ID; supplied writable fields",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_suggest",
    v4: { target: "raindrop_read", action: "suggest" },
    schema: envelope("raindrop_suggest"),
    tests: ["raindrop_v3_contract.test.ts"],
    upstream: [
      "id: GET /raindrop/{id}/suggest",
      "link: POST /raindrop/suggest",
    ],
    budget: budget("1", "id<=4; link=1 at-most-once; request cap=20"),
    scope: "exactly one bookmark ID or HTTP(S) link",
    errors: writeErrors,
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_bulk_update",
    v4: { target: "raindrop_bulk_update", action: "execute" },
    schema: envelope("raindrop_bulk_update"),
    tests: ["v3_mutation_contract.test.ts"],
    upstream: ["PUT /raindrops/{collectionId}"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one explicit source and <=50 deduplicated IDs",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_bulk_delete",
    v4: { target: "raindrop_bulk_delete", action: "execute" },
    schema: envelope("raindrop_bulk_delete"),
    tests: ["v3_mutation_contract.test.ts"],
    upstream: [
      "confirm=false: none",
      "confirm=true: DELETE /raindrops/{collectionId}",
    ],
    budget: budget(
      "preview=0; confirmed=1",
      "preview=0; confirmed=1 at-most-once",
    ),
    scope:
      "one explicit source and <=50 deduplicated IDs; permanent only in Trash",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "raindrop_delete",
    v4: { target: "raindrop_delete", action: "execute" },
    schema: envelope("raindrop_delete"),
    tests: ["v3_mutation_contract.test.ts"],
    upstream: [
      "GET /raindrop/{id}",
      "confirmed: DELETE /raindrops/{currentCollectionId}",
    ],
    budget: budget(
      "preview=1; confirmed=2",
      "preview<=4; confirmed<=5; request cap=20",
    ),
    scope: "fresh source of one bookmark; permanent only in Trash",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "collection_list",
    v4: { target: "collection_read", action: "list" },
    schema: envelope("collection_list"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: ["GET /collections", "GET /collections/childrens"],
    budget: budget("2", "<=8; request cap=20"),
    scope: "complete bounded root+child index, locally paged",
    errors: [...commonErrors, "RESOURCE_LIMIT"],
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "collection_tree",
    v4: { target: "collection_read", action: "tree" },
    schema: envelope("collection_tree"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: ["GET /collections", "GET /collections/childrens"],
    budget: budget("2", "<=8; request cap=20"),
    scope: "complete bounded hierarchy including unattached nodes",
    errors: [...commonErrors, "RESOURCE_LIMIT"],
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "collection_get",
    v4: { target: "collection_read", action: "get" },
    schema: envelope("collection_get"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: ["GET /collection/{id}"],
    budget: budget("1", "<=4; request cap=20"),
    scope: "one positive collection ID",
    errors: commonErrors,
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "collection_create",
    v4: { target: "collection_create", action: "execute" },
    schema: envelope("collection_create"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: ["POST /collection"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one title and optional positive parent",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "collection_update",
    v4: { target: "collection_update", action: "execute" },
    schema: envelope("collection_update"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: [
      "title only: PUT /collection/{id}",
      "parent change: GET /collections + GET /collections/childrens + PUT /collection/{id}",
      "parent=null: none",
    ],
    budget: budget(
      "title=1; parent=3; parent-null=0",
      "title=1; parent<=9; parent-null=0; request cap=20",
    ),
    scope: "one collection; validated non-root parent or title",
    errors: [...writeErrors, "FEATURE_UNVERIFIED", "RESOURCE_LIMIT"],
    annotations: write,
    featureGate: "parent-null-disabled",
  },
  {
    v3Tool: "collection_delete",
    v4: { target: "collection_delete", action: "execute" },
    schema: envelope("collection_delete"),
    tests: ["v3_collection_contract.test.ts"],
    upstream: [
      "GET /collections",
      "GET /collections/childrens",
      "confirmed: DELETE /collection/{id}",
    ],
    budget: budget(
      "preview=2; confirmed=3",
      "preview<=8; confirmed<=9; request cap=20",
    ),
    scope: "fresh exact subtree; optional known-empty leaf",
    errors: [...writeErrors, "SCOPE_CHANGED", "RESOURCE_LIMIT"],
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "tag_list",
    v4: { target: "tag_read", action: "list" },
    schema: envelope("tag_list"),
    tests: ["v3_tag_contract.test.ts"],
    upstream: ["GET /tags or GET /tags/{collectionId}"],
    budget: budget("1", "<=4; request cap=20"),
    scope: "global when ID omitted, otherwise one explicit collection",
    errors: [...commonErrors, "RESOURCE_LIMIT"],
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "tag_rename",
    v4: { target: "tag_rename", action: "execute" },
    schema: envelope("tag_rename"),
    tests: ["v3_tag_contract.test.ts"],
    upstream: ["confirmed: PUT /tags or PUT /tags/{collectionId}"],
    budget: budget(
      "preview=0; confirmed=1",
      "preview=0; confirmed=1 at-most-once",
    ),
    scope: "explicit global or collection scope; exactly one source tag",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "tag_merge",
    v4: { target: "tag_merge", action: "execute" },
    schema: envelope("tag_merge"),
    tests: ["v3_tag_contract.test.ts"],
    upstream: ["confirmed: PUT /tags or PUT /tags/{collectionId}"],
    budget: budget(
      "preview=0; confirmed=1",
      "preview=0; confirmed=1 at-most-once",
    ),
    scope: "explicit global or collection scope; 2..50 distinct tags",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "tag_delete",
    v4: { target: "tag_delete", action: "execute" },
    schema: envelope("tag_delete"),
    tests: ["v3_tag_contract.test.ts"],
    upstream: ["confirmed: DELETE /tags or DELETE /tags/{collectionId}"],
    budget: budget(
      "preview=0; confirmed=1",
      "preview=0; confirmed=1 at-most-once",
    ),
    scope: "explicit global or collection scope; 1..50 distinct tags",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "highlight_list",
    v4: { target: "highlight_read", action: "list" },
    schema: envelope("highlight_list"),
    tests: ["v3_highlight_contract.test.ts"],
    upstream: [
      "GET /highlights or /highlights/{collectionId}",
      "bookmark scope: GET /raindrop/{id}",
    ],
    budget: budget("1", "<=4; request cap=20"),
    scope: "global, one collection, or one bookmark; one page",
    errors: commonErrors,
    annotations: read,
    featureGate: "none",
  },
  {
    v3Tool: "highlight_create",
    v4: { target: "highlight_create", action: "execute" },
    schema: envelope("highlight_create"),
    tests: ["v3_highlight_contract.test.ts"],
    upstream: ["PUT /raindrop/{id}"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one new highlight on one bookmark",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "highlight_update",
    v4: { target: "highlight_update", action: "execute" },
    schema: envelope("highlight_update"),
    tests: ["v3_highlight_contract.test.ts"],
    upstream: ["PUT /raindrop/{id}"],
    budget: budget("1", "1; submitted write is at-most-once"),
    scope: "one exact string highlight ID on one bookmark",
    errors: writeErrors,
    annotations: write,
    featureGate: "none",
  },
  {
    v3Tool: "highlight_delete",
    v4: { target: "highlight_delete", action: "execute" },
    schema: envelope("highlight_delete"),
    tests: ["v3_highlight_contract.test.ts"],
    upstream: ["GET /raindrop/{id}", "confirmed: PUT /raindrop/{id}"],
    budget: budget(
      "preview=1; confirmed=2",
      "preview<=4; confirmed<=5; request cap=20",
    ),
    scope: "one exact string highlight ID on one bookmark",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
  {
    v3Tool: "library_audit",
    v4: { target: "audit_read", action: "check" },
    schema: envelope("library_audit"),
    tests: ["v3_audit_contract.test.ts"],
    upstream: [
      "untagged: GET /raindrops/{collectionId}",
      "duplicates/broken: GET /user/stats + GET /raindrops/{collectionId}",
      "empty: GET /collections + GET /collections/childrens",
    ],
    budget: budget(
      "untagged=1; duplicates/broken=2; empty=2",
      "untagged<=4; duplicates/broken/empty<=8; request cap=20",
    ),
    scope: "one audit kind, collection scope and one page",
    errors: [
      ...commonErrors,
      "FEATURE_UNAVAILABLE",
      "FEATURE_UNVERIFIED",
      "RESOURCE_LIMIT",
    ],
    annotations: read,
    featureGate: "pro-entitlement-runtime",
  },
  {
    v3Tool: "duplicates_delete",
    v4: { target: "duplicates_delete", action: "execute" },
    schema: envelope("duplicates_delete"),
    tests: ["v3_audit_contract.test.ts"],
    upstream: [
      "confirm=true while gate off: none",
      "preview: GET /user/stats + GET /raindrops/{collectionId} + one GET /raindrop/{id} per on-page requested ID",
    ],
    budget: budget(
      "gated confirm=0; preview=2+N where 0<=N<=10",
      "gated confirm=0; preview<=12 logical reads and <=20 attempts hard cap",
    ),
    scope: "one source, one duplicate page, <=10 distinct candidate IDs",
    errors: [...writeErrors, "FEATURE_UNAVAILABLE", "FEATURE_UNVERIFIED"],
    annotations: destructive,
    featureGate: "duplicate-execution-disabled",
  },
  {
    v3Tool: "trash_empty",
    v4: { target: "trash_empty", action: "execute" },
    schema: envelope("trash_empty"),
    tests: ["v3_cleanup_contract.test.ts"],
    upstream: ["preview: GET /user/stats", "confirmed: DELETE /collection/-99"],
    budget: budget(
      "preview=1; confirmed=1",
      "preview<=4; confirmed=1 at-most-once; request cap=20",
    ),
    scope: "entire Trash at execution time",
    errors: writeErrors,
    annotations: destructive,
    featureGate: "none",
  },
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("Raindrop v4 T01 contract baseline (v3 source cc05fc9)", () => {
  // Historical T01 matrix stays pinned exclusively to the frozen 26 v3 tools.
  const tools = buildToolConfigs({ serverVersion: "3.0.0" }).toolConfigs.filter(
    (tool) => tool.name !== "diagnostics_read" && tool.name !== "raindrop_read",
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const readTargets = Object.values(V4_READ_ACTION_BASELINE).flatMap(
    (actions) => Object.values(actions),
  );
  const uniqueReadTargets = [...new Set(readTargets)];
  const mutationTargets = [...V4_INDEPENDENT_MUTATION_BASELINE];

  it("maps all and only the 26 v3 tools to 10 pure-read capabilities and 16 independent mutations", () => {
    expect(Object.keys(V4_READ_ACTION_BASELINE)).toHaveLength(6);
    expect(uniqueReadTargets).toHaveLength(10);
    expect(mutationTargets).toHaveLength(16);
    expect(readTargets).toHaveLength(11); // diagnostics has two read-only actions
    const mapped = [...uniqueReadTargets, ...mutationTargets];
    expect(new Set(mapped).size).toBe(26);
    expect([...mapped].sort()).toEqual(tools.map((tool) => tool.name).sort());
    expect(tools).toHaveLength(26);
  });

  it("has one complete, resolvable contract row for every v3 tool", () => {
    expect(V3_TOOL_CONTRACT_MATRIX).toHaveLength(26);
    expect(new Set(V3_TOOL_CONTRACT_MATRIX.map((row) => row.v3Tool)).size).toBe(
      26,
    );
    expect(V3_TOOL_CONTRACT_MATRIX.map((row) => row.v3Tool).sort()).toEqual(
      tools.map((tool) => tool.name).sort(),
    );

    for (const row of V3_TOOL_CONTRACT_MATRIX) {
      const tool = byName.get(row.v3Tool);
      expect(tool, row.v3Tool).toBeDefined();
      expect(row.v4.target.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.v4.action.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.schema.input, row.v3Tool).toBe(
        `buildToolConfigs:${row.v3Tool}.inputSchema`,
      );
      expect(
        tool?.inputSchema.safeParse({ __unknownField: true }).success,
        row.v3Tool,
      ).toBe(false);
      expect(row.schema.output, row.v3Tool).toBe("ToolEnvelopeSchema");
      expect(tool?.outputSchema ?? ToolEnvelopeSchema, row.v3Tool).toBe(
        ToolEnvelopeSchema,
      );
      expect(row.tests.length, row.v3Tool).toBeGreaterThan(0);
      expect(
        row.tests.every((test) => test.endsWith("_contract.test.ts")),
        row.v3Tool,
      ).toBe(true);
      expect(
        row.tests.every((test) => existsSync(new URL(test, import.meta.url))),
        row.v3Tool,
      ).toBe(true);
      expect(
        row.tests.some((test) =>
          readFileSync(new URL(test, import.meta.url), "utf8").includes(
            row.v3Tool,
          ),
        ),
        `${row.v3Tool}: referenced tests must name the tool`,
      ).toBe(true);
      expect(row.upstream.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.budget.nominal.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.budget.maximum.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.budget.counting, row.v3Tool).toBe(COUNTING);
      expect(row.scope.length, row.v3Tool).toBeGreaterThan(0);
      expect(row.errors, row.v3Tool).toContain("VALIDATION_ERROR");
      expect(new Set(row.errors).size, row.v3Tool).toBe(row.errors.length);
      expect(
        row.errors.every((code) => knownErrorCodes.has(code)),
        row.v3Tool,
      ).toBe(true);
      expect(row.annotations, row.v3Tool).toEqual(tool?.annotations);
      expect(
        [
          "none",
          "parent-null-disabled",
          "duplicate-execution-disabled",
          "pro-entitlement-runtime",
        ],
        row.v3Tool,
      ).toContain(row.featureGate);
    }
  });

  it("pins the complete contract matrix against silent semantic drift", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(V3_TOOL_CONTRACT_MATRIX))
      .digest("hex");
    expect(digest).toBe(EXPECTED_CONTRACT_SHA256);
  });

  it("keeps read grouping and independent mutation targets synchronized with the per-tool matrix", () => {
    for (const [target, actions] of Object.entries(V4_READ_ACTION_BASELINE)) {
      for (const [action, v3Tool] of Object.entries(actions)) {
        const row = V3_TOOL_CONTRACT_MATRIX.find(
          (candidate) => candidate.v3Tool === v3Tool,
        );
        expect(row, `${target}.${action}`).toBeDefined();
        expect(row?.v4.target, `${target}.${action}`).toBe(target);
        expect(row?.v4.action.split("|"), `${target}.${action}`).toContain(
          action,
        );
      }
    }
    for (const v3Tool of V4_INDEPENDENT_MUTATION_BASELINE) {
      const row = V3_TOOL_CONTRACT_MATRIX.find(
        (candidate) => candidate.v3Tool === v3Tool,
      );
      expect(row?.v4, v3Tool).toEqual({ target: v3Tool, action: "execute" });
    }
  });

  it("never maps writes, deletions or batch operations into a read-only action", () => {
    for (const name of uniqueReadTargets) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of mutationTargets) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(uniqueReadTargets).not.toContain("duplicates_delete");
    expect(uniqueReadTargets).not.toContain("trash_empty");
  });

  it("requires strict existing input schemas and structured output envelopes for all mappings", () => {
    for (const tool of tools) {
      const result = tool.inputSchema.safeParse({ __unknownField: true });
      expect(result.success, tool.name).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.map((issue) => issue.code),
          tool.name,
        ).toContain("unrecognized_keys");
      }
      // The real emitted outputSchema is checked through Client.listTools below.
    }
  });

  it("exercises real SDK Client discovery and local diagnostics without asserting Portal negotiation", async () => {
    const upstream = vi.fn(() => {
      throw new Error(
        "No upstream request allowed in the offline protocol fixture",
      );
    });
    vi.stubGlobal("fetch", upstream);
    const service = new RaindropMCPService({
      accessToken: "synthetic-t01-token",
      maxReadRetries: 0,
    });
    const client = new Client({ name: "v4-t01-offline-only", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const discovered = (await client.listTools()).tools;
      expect(discovered.map((tool) => tool.name).sort()).toEqual(
        [...tools.map((tool) => tool.name), "diagnostics_read", "raindrop_read"].sort(),
      );
      // Assert the public wire-level SDK schema, not an always-defined local fallback.
      // Every v3 tool deliberately uses the same structured success/error envelope.
      for (const tool of discovered) {
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: "object",
          properties: {
            ok: { type: "boolean" },
            meta: { type: "object" },
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        });
        expect(tool.outputSchema?.required, tool.name).toEqual(
          expect.arrayContaining(["ok", "meta"]),
        );
      }
      expect(
        (await client.listResources()).resources
          .map((resource) => resource.uri)
          .sort(),
      ).toEqual(["diagnostics://server", "mcp://user/profile"]);
      expect(
        (await client.listResourceTemplates()).resourceTemplates.map(
          (template) => template.uriTemplate,
        ),
      ).toEqual(["mcp://collection/{id}", "mcp://raindrop/{id}"]);
      expect(
        (await client.listPrompts()).prompts
          .map((prompt) => prompt.name)
          .sort(),
      ).toEqual(["export_markdown", "find_duplicates", "organize_by_topic"]);
      const result = await client.callTool({
        name: "diagnostics",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { protocolVersion: null },
        meta: { requestCount: 0 },
      });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("retains the resource/prompt discovery baseline without reaching upstream", async () => {
    const service = new RaindropMCPService({
      accessToken: "synthetic-t01-token",
    });
    try {
      expect(
        service
          .listResources()
          .map((r) => r.uri)
          .sort(),
      ).toEqual(["diagnostics://server", "mcp://user/profile"]);
      const manifest = (await service.getManifest()) as {
        prompts: Array<{ name: string }>;
        capabilities: Record<string, unknown>;
      };
      expect(manifest.prompts.map((p) => p.name).sort()).toEqual([
        "export_markdown",
        "find_duplicates",
        "organize_by_topic",
      ]);
      expect(Object.keys(manifest.capabilities).sort()).toEqual([
        "prompts",
        "resources",
        "tools",
      ]);
    } finally {
      await service.cleanup();
    }
  });
});
