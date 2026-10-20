import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFileInfo, parseListDirectory, parseLocalRead,
  parseReadMultiple, parseSearchStart,
  parseLocalWriteFile, parseLocalCreateDirectory, parseLocalDeleteFile,
  parseLocalEditBlock, parseLocalMoveFile,
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

test("Windows absolute paths are allowed for paired full file operations", () => {
  const operation_id = "windows-full-1";
  const write = { operation_id, path: win, content: "safe-test", mode: "rewrite" };
  const directory = "C:/Users/0/AppData/Local/Temp/rca-test";
  const destination = "C:/Windows/renamed.ini";
  assert.equal(parseLocalWriteFile(write)?.path, win);
  assert.equal(parseLocalCreateDirectory({ operation_id, path: directory })?.path, directory);
  assert.equal(parseLocalDeleteFile({ operation_id, path: win })?.path, win);
  assert.equal(parseLocalEditBlock({
    operation_id, file_path: win, old_string: "before", new_string: "after",
  })?.filePath, win);
  assert.deepEqual(parseLocalMoveFile({ operation_id, source: win, destination })?.destination, destination);
  assert.equal(parseLocalWriteFile({ ...write, path: unix })?.path, unix);
});

test("Windows file mutations still reject URLs, UNC/device namespaces, ADS, relative drives and bad paths", () => {
  const operation_id = "windows-full-2";
  const invalid = [
    "https://example.org/write", "file:///C:/Windows/win.ini",
    "C:Windows\\\\win.ini", "C://Windows/win.ini",
    String.raw`\\\\server\\share\\file.txt`,
    String.raw`\\\\?\\C:\\Windows\\win.ini`,
    String.raw`C:\\Windows\\win.ini:evil`,
    String.raw`C:\\Windows\\a?.txt`,
    "C:/Windows/a" + String.fromCharCode(0) + "b.txt",
  ];
  for (const path of invalid) {
    assert.equal(parseLocalWriteFile({ operation_id, path, content: "x", mode: "rewrite" }), null, path);
    assert.equal(parseLocalCreateDirectory({ operation_id, path }), null, path);
    assert.equal(parseLocalDeleteFile({ operation_id, path }), null, path);
    assert.equal(parseLocalEditBlock({ operation_id, file_path: path, old_string: "x", new_string: "y" }), null, path);
    assert.equal(parseLocalMoveFile({ operation_id, source: path, destination: win }), null, path);
    assert.equal(parseLocalMoveFile({ operation_id, source: win, destination: path }), null, path);
  }
});

