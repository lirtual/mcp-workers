import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

function file(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("IMA tool registry exposes no public export or temporary-upload capability", () => {
  const tools = file("../../src/tools.ts");
  assert.ok(!tools.includes('registerTool("export_file"'));
  assert.doesNotMatch(tools, /export_to_temporary/);
  assert.doesNotMatch(tools, /Litterbox|litterbox/);
  assert.ok(tools.includes('registerTool("read_knowledge_source"'));
  assert.ok(tools.includes('registerTool("upload_file_to_knowledge_base"'));
});

test("IMA registers all 15 read and write tools without a Worker-side allowWrite gate", () => {
  const registry = file("../../src/tools.ts");
  const entry = file("../../src/index.ts");
  const toolNames = [...registry.matchAll(/server\.registerTool\("([^"]+)"/g)].map(match => match[1]);
  assert.equal(toolNames.length, 15);
  for (const name of [
    "search_notes", "get_note", "read_knowledge_source",
    "create_note", "append_note", "add_urls_to_knowledge_base",
    "add_note_to_knowledge_base", "upload_file_to_knowledge_base"
  ]) assert.ok(toolNames.includes(name), name);
  assert.doesNotMatch(registry, /allowWrite|if\s*\(\s*allowWrite\s*\)/);
  assert.match(entry, /registerTools\(server, notes, new ImaKnowledge\(runtimeEnv, api\)\)/);
});

test("IMA has no note or knowledge export implementation and no public uploader", () => {
  const impl = file("../../src/ima.ts");
  assert.doesNotMatch(impl, /exportNote|exportSource|uploadTemporaryFile|export_to_temporary|Litterbox/);
  for (const path of ["../../src/temporary-upload.ts", "../../src/exporting-notes.ts", "../../src/note-image-resign.ts"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
  assert.doesNotMatch(file("../../src/instructions.ts"), /export_file|export_to_temporary|Litterbox/);
});
