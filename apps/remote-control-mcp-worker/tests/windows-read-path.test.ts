import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFileInfo, parseListDirectory, parseLocalRead,
  parseReadMultiple, parseSearchStart,
  parseLocalWriteFile,
} from "../src/local-read.ts";

const win = String.raw`C:\Windows\win.ini`;
const unix = "/tmp/marker.txt";

test("Windows drive-absolute paths route through all read-only parser variants", () => {
  assert.equal(parseLocalRead({ path: win, length: 3 })?.path, win);
  assert.deepEqual(parseReadMultiple({ paths: [win, unix] })?.paths, [win, unix]);
  assert.equal(parseListDirectory({ path: String.raw`C:\Windows`, depth: 1 })?.path, String.raw`C:\Windows`);
  assert.equal(parseFileInfo({ path: win })?.path, win);
  assert.equal(parseSearchStart({ path: String.raw`C:\Users`, pattern: "txt", search_type: "filename" })?.path, String.raw`C:\Users`);
  assert.equal(parseLocalRead({ path: "C:/Windows/win.ini" })?.path, "C:/Windows/win.ini");
  assert.equal(parseLocalRead({ path: unix })?.path, unix);
});

test("Windows read parser rejects URL schemes, UNC/device namespaces, ADS and relative drives", () => {
  const invalid = [
    "https://example.org/read", "file:///C:/Windows/win.ini",
    "C:Windows\\win.ini", "C://Windows/win.ini",
    String.raw`\\server\share\file.txt`,
    String.raw`\\?\C:\Windows\win.ini`,
    String.raw`C:\Windows\win.ini:evil`,
    String.raw`C:\Windows\a?.txt`,
    "C:/Windows/a" + String.fromCharCode(0) + "b.txt",
  ];
  for (const path of invalid) {
    assert.equal(parseLocalRead({ path }), null, path);
    assert.equal(parseReadMultiple({ paths: [path] }), null, path);
    assert.equal(parseListDirectory({ path }), null, path);
    assert.equal(parseFileInfo({ path }), null, path);
    assert.equal(parseSearchStart({ path, pattern: "txt", search_type: "filename" }), null, path);
  }
});

test("Windows read support must never loosen mutation path validation", () => {
  const write = { operation_id: "windows-read-check-1", path: win, content: "never", mode: "rewrite" };
  assert.equal(parseLocalWriteFile({ ...write, path: unix })?.path, unix);
  assert.equal(parseLocalWriteFile(write), null);
});
