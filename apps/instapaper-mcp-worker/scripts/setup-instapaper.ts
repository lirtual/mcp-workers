#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { exchangeXAuth } from "../src/instapaper/oauth.js";
import { InstapaperClient } from "../src/instapaper/client.js";

const rl = createInterface({ input, output });

function requireWranglerAuthentication() {
  const result = spawnSync("npx", ["wrangler", "whoami"], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      "Wrangler authentication is required before automatic setup. Run `npx wrangler login`, set CLOUDFLARE_API_TOKEN, or rerun with `--manual`.",
    );
  }
}

function putSecret(name: string, value: string) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to store ${name} with Wrangler.`);
  }
}

function writeManualSecrets(secrets: Record<string, string>) {
  const outputDirectory = mkdtempSync(join(tmpdir(), "instapaper-mcp-"));
  const outputPath = join(outputDirectory, "secrets.txt");
  const contents = Object.entries(secrets)
    .map(([name, value]) => `[${name}]\n${value}`)
    .join("\n");

  chmodSync(outputDirectory, 0o700);
  writeFileSync(outputPath, `${contents}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(outputPath, 0o600);

  return { outputDirectory, outputPath };
}

async function main() {
  const manual = process.argv.slice(2).includes("--manual");
  if (!manual) {
    output.write("Checking Cloudflare authentication...\n");
    requireWranglerAuthentication();
  }

  const consumerKey = process.env.INSTAPAPER_CONSUMER_KEY || (await rl.question("Instapaper consumer key: ")).trim();
  const consumerSecret = process.env.INSTAPAPER_CONSUMER_SECRET || (await rl.question("Instapaper consumer secret: ")).trim();
  const username = (await rl.question("Instapaper username/email: ")).trim();
  const password = process.env.INSTAPAPER_PASSWORD ?? (await rl.question("Instapaper password (may be empty): "));

  if (!consumerKey || !consumerSecret || !username) {
    throw new Error("Consumer key, consumer secret, and username are required.");
  }

  const tokens = await exchangeXAuth({ consumerKey, consumerSecret, username, password });
  const client = new InstapaperClient({
    consumerKey,
    consumerSecret,
    oauthToken: tokens.token,
    oauthTokenSecret: tokens.tokenSecret,
  });
  const user = await client.verifyCredentials();

  output.write(`\nAuthenticated as ${user.username ?? user.user_id ?? "Instapaper user"}.\n`);

  const secrets = {
    INSTAPAPER_CONSUMER_KEY: consumerKey,
    INSTAPAPER_CONSUMER_SECRET: consumerSecret,
    INSTAPAPER_OAUTH_TOKEN: tokens.token,
    INSTAPAPER_OAUTH_TOKEN_SECRET: tokens.tokenSecret,
  };

  if (manual) {
    const { outputDirectory, outputPath } = writeManualSecrets(secrets);
    output.write(`Credentials written to temporary file ${outputPath}.\n`);
    output.write(`Copy the raw value below each name into Cloudflare Worker Secrets, then delete the file with: rm -rf ${outputDirectory}\n`);
    output.write("Username/password were not persisted.\n");
    return;
  }

  output.write("Writing credentials to Cloudflare Worker secrets...\n");
  for (const [name, value] of Object.entries(secrets)) {
    putSecret(name, value);
  }
  output.write("Instapaper credentials stored. Username/password were not persisted.\n");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Instapaper setup failed.");
    process.exitCode = 1;
  })
  .finally(() => rl.close());
