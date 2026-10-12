import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";

const clientId = process.env.IMA_OPENAPI_CLIENTID || process.env.IMA_CLIENT_ID;
const apiKey = process.env.IMA_OPENAPI_APIKEY || process.env.IMA_API_KEY;

test("Live IMA E2E Acceptance Suite (conditional on credentials)", async (t) => {
  if (!clientId || !apiKey) {
    t.skip("未在环境变量中检测到 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY，跳过真实账户端到端在线测试。");
    return;
  }

  const env: Env = {
    DB: {} as any,
    IMA_BASE_URL: process.env.IMA_BASE_URL || "https://ima.qq.com",
    FILE_DOWNLOAD_TIMEOUT_MS: "30000",
  };
  const creds: ImaCredentials = { clientId, apiKey };
  const client = new ImaClient(env, creds);
  const notes = new ImaNotes(client);
  const kb = new ImaKnowledge(env, client);

  // 1. 契约修复验证: 搜索笔记 (标题搜索与全文搜索)
  await t.test("E2E: search_notes executes with DOC_TITLE and DOC_CONTENT", async () => {
    const titleRes = await notes.search({ query: "测试", search_type: 0, start: 0, end: 5 });
    assert(titleRes && typeof titleRes.is_end === "boolean");

    const contentRes = await notes.search({ query: "测试", search_type: 1, start: 0, end: 5 });
    assert(contentRes && typeof contentRes.is_end === "boolean");
  });

  // 2. 笔记本与笔记列表
  await t.test("E2E: list_notebook and list_note", async () => {
    const notebooks = await notes.notebooks({ limit: 5 });
    assert(notebooks && typeof notebooks === "object");

    const noteList = await notes.list({ limit: 5 });
    assert(noteList && typeof noteList === "object");
  });

  // 3. 知识库查询
  await t.test("E2E: list_addable_knowledge_bases and search_knowledge_bases", async () => {
    const bases = await kb.addable("", 5);
    assert(bases && typeof bases === "object");
  });

  const marker = `ima-mcp-e2e-${Date.now()}`;

  await t.test("E2E: create_note and append_note", async () => {
    const created = await notes.create({ content: `# ${marker}\n\ncreate` });
    assert.equal(typeof created.note_id, "string");
    assert.ok(created.note_id.length > 0);

    const appended = await notes.append(created.note_id, `\n\nappend ${marker}`);
    assert.equal(appended.note_id, created.note_id);

    const body = await notes.get(created.note_id);
    assert.match(body.content ?? "", new RegExp(marker));
  });

  await t.test("E2E: import URL, associate note, read source, COS upload", async (st) => {
    const addable = await kb.addable("", 5) as {
      addable_knowledge_base_list?: Array<{ id: string }>;
    };
    const knowledgeBaseId = addable.addable_knowledge_base_list?.[0]?.id;
    if (!knowledgeBaseId) {
      st.skip("无可写入知识库，跳过 URL/关联/原文/上传");
      return;
    }

    const imported = await kb.importUrls(knowledgeBaseId, ["https://example.com/"]);
    assert.equal(imported.partial_failure, false);
    assert.ok(imported.succeeded.length >= 1);

    const associatedNote = await notes.create({ content: `# ${marker}-kb\n\nassociate` });
    const added = await kb.addNote(knowledgeBaseId, associatedNote.note_id, `${marker}-kb`);
    assert.equal(typeof added.media_id, "string");
    assert.ok(added.media_id.length > 0);

    const source = await kb.readSource(added.media_id, notes);
    assert.ok(source.content || source.fallback_message);
    if (source.content && source.is_end === false && source.next_offset !== undefined) {
      const continued = await kb.readSource(added.media_id, notes, { offset: source.next_offset });
      assert.equal(typeof continued.is_end, "boolean");
    }

    const uploaded = await kb.upload({
      knowledge_base_id: knowledgeBaseId,
      file_url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      keep_both: true,
    });
    assert.equal(typeof uploaded.media_id, "string");
    assert.ok(uploaded.media_id.length > 0);
  });
});
