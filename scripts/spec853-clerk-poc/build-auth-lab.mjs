/** Reproducible one-file bundle, never bundles secret values. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const sdkRoot = process.env.SPEC853_SDK_CACHE;
if (!sdkRoot) throw Error("SPEC853_SDK_CACHE must point to isolated Clerk SDK install");
const esbuild = await import(pathToFileURL(join(sdkRoot, "node_modules/esbuild/lib/main.js")).href);
const entry = await readFile(new URL("./auth-lab-worker.mjs", import.meta.url), "utf8");
const built = await esbuild.build({
  stdin: { contents: entry, sourcefile: "auth-lab-worker.mjs", resolveDir: sdkRoot, loader: "js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["worker", "browser"],
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
});
const code = built.outputFiles[0].text;
if (/sk_(?:test|live)_[A-Za-z0-9_-]{20,}/.test(code))
  throw Error("A credential-like value would be bundled");
const dest = resolve(process.env.SPEC853_BUNDLE_OUTPUT || "/tmp/spec853-auth-lab.bundle.mjs");
await mkdir(join(dest, ".."), { recursive: true });
await writeFile(dest, code);
console.log(JSON.stringify({ path: dest, bytes: Buffer.byteLength(code),
  sha256: createHash("sha256").update(code).digest("hex") }));
