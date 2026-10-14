import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

function file(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("IMA tool registry exposes no public export or temporary-upload capability", () => {
  const tools = file("../../src/tools.ts");
  assert.doesNotMatch(tools, /registerTool\\("export_file"/);
  assert.doesNotMatch(tools, /export_to_temporary/);
  assert.doesNotMatch(tools, /Litterbox|litterbox\\.catbox/);
  assert.match(tools, /registerTool\\("read_knowledge_source"/);
  assert.match(tools, /registerTool\\("upload_file_to_knowledge_base"/);
});

test("IMA has no note or knowledge export implementation and no public uploader", () => {
  const impl = file("../../src/ima.ts");
  assert.doesNotMatch(impl, /exportNote\\(|exportSource\\(|uploadTemporaryFile|export_to_temporary|Litterbox/);
  for (const path of ["../../src/temporary-upload.ts", "../../src/exporting-notes.ts", "../../src/note-image-resign.ts"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
  assert.doesNotMatch(file("../../src/instructions.ts"), /export_file|export_to_temporary|Litterbox/);
});
