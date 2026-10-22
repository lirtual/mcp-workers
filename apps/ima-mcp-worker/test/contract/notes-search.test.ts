import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaNotes } from "../../src/ima.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

const mockEnv: Env = { IMA_BASE_URL: "https://ima.qq.com" };
const mockCreds: ImaCredentials = { clientId: "test_client_id", apiKey: "test_api_key" };
const fixture = [
  { note_id: "a", title: "Cloudflare design", create_time: "1", modify_time: "4", content: "nothing relevant" },
  { note_id: "b", title: "Project notes", create_time: "4", modify_time: "3", content: "Read Cloudflare docs" },
  { note_id: "c", title: "cloudflare tips", create_time: "3", modify_time: "2", content: "no matching body" },
  { note_id: "d", title: "General", create_time: "2", modify_time: "1", content: "no matching body" },
];

function mockNotes(notes = fixture) {
  return setupMockFetch(req => {
    if (req.url.endsWith("/list_note")) {
      const start = req.body.cursor === "second" ? 2 : 0;
      const entries = notes.slice(start, start + 2).map(({ content, ...note }) => note);
      return new Response(JSON.stringify({ code: 0, data: {
        note_book_list: entries,
        is_end: start + 2 >= notes.length,
        next_cursor: start + 2 >= notes.length ? "" : "second",
      } }));
    }
    if (req.url.endsWith("/get_doc_content")) {
      const match = notes.find(note => note.note_id === req.body.note_id);
      return new Response(JSON.stringify({ code: 0, data: { content: match?.content ?? "" } }));
    }
    throw new Error(`Unexpected IMA endpoint: ${req.url}`);
  });
}

function clientNotes() { return new ImaNotes(new ImaClient(mockEnv, mockCreds)); }

test("title search is exact, case-insensitive, correctly counted and paginated", async () => {
  const { captured, restore } = mockNotes();
  try {
    const notes = clientNotes();
    const first = await notes.search({ query: "CLOUDFLARE", start: 0, end: 1 });
    const second = await notes.search({ query: "CLOUDFLARE", start: 1, end: 2 });
    const exhausted = await notes.search({ query: "CLOUDFLARE", start: 2, end: 3 });
    assert.deepStrictEqual(first.search_note_infos.map(item => item.note_book_info.note_id), ["a"]);
    assert.deepStrictEqual(second.search_note_infos.map(item => item.note_book_info.note_id), ["c"]);
    assert.deepStrictEqual(exhausted.search_note_infos, []);
    assert.equal(first.total_hit_num, 2);
    assert.equal(first.is_end, false);
    assert.equal(second.is_end, true);
    assert.equal(exhausted.total_hit_num, 2);
    assert.equal(exhausted.is_end, true);
    assert.ok(captured.every(req => req.url.endsWith("/list_note")));
    assert.equal(captured[0].body.cursor, "");
    assert.equal(captured[1].body.cursor, "second");
    assert.equal(captured[0].headers["ima-openapi-clientid"], "test_client_id");
  } finally { restore(); }
});

test("body search reads actual full text, not only title or summary", async () => {
  const { captured, restore } = mockNotes();
  try {
    const result = await clientNotes().search({ query: "Cloudflare", search_type: 1 });
    assert.deepStrictEqual(result.search_note_infos.map(item => item.note_book_info.note_id), ["b"]);
    assert.equal(result.total_hit_num, 1);
    assert.equal(result.is_end, true);
    assert.equal(captured.filter(req => req.url.endsWith("/get_doc_content")).length, 4);
    assert.ok(captured.every(req => !req.url.endsWith("/search_note")));
  } finally { restore(); }
});

test("sorting by creation time, title and body byte size remains available", async () => {
  const { restore } = mockNotes();
  try {
    const notes = clientNotes();
    const created = await notes.search({ query: "", sort_type: 1 });
    assert.deepStrictEqual(created.search_note_infos.map(x => x.note_book_info.note_id), ["b", "c", "d", "a"]);
    const title = await notes.search({ query: "", sort_type: 2 });
    assert.deepStrictEqual(title.search_note_infos.map(x => x.note_book_info.note_id), ["a", "c", "d", "b"]);
    const size = await notes.search({ query: "", sort_type: 3 });
    assert.equal(size.total_hit_num, 4);
    assert.equal(size.search_note_infos.length, 4);
  } finally { restore(); }
});

test("no match has zero total; invalid page size is rejected", async () => {
  const { restore } = mockNotes();
  try {
    assert.deepStrictEqual(await clientNotes().search({ query: "notpresent" }), {
      search_note_infos: [], total_hit_num: 0, is_end: true,
    });
    await assert.rejects(() => clientNotes().search({ query: "x", start: 20, end: 10 }), /end must be greater than start/i);
    await assert.rejects(() => clientNotes().search({ query: "x", start: 0, end: 50 }), /maximum page size 20/i);
  } finally { restore(); }
});

test("missing list cursor fails rather than asserting a complete result", async () => {
  const { restore } = setupMockFetch(() => new Response(JSON.stringify({ code: 0, data: {
    note_book_list: fixture.slice(0, 1), is_end: false, next_cursor: "",
  } })));
  try {
    await assert.rejects(() => clientNotes().search({ query: "Cloudflare" }), /no next cursor/);
  } finally { restore(); }
});

test("collections exceeding the scan bound fail closed without partial matches", async () => {
  const { captured, restore } = setupMockFetch(req => {
    assert.ok(req.url.endsWith("/list_note"));
    const page = Number(req.body.cursor || 0);
    const note_book_list = Array.from({ length: 20 }, (_, index) => ({
      note_id: String(page * 20 + index), title: "Cloudflare",
    }));
    return new Response(JSON.stringify({ code: 0, data: {
      note_book_list, is_end: false, next_cursor: String(page + 1),
    } }));
  });
  try {
    await assert.rejects(() => clientNotes().search({ query: "Cloudflare" }), /limited to 100 notes/);
    assert.equal(captured.length, 5);
  } finally { restore(); }
});
