#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { exchangeXAuth } from "../src/instapaper/oauth.js";
import { InstapaperClient } from "../src/instapaper/client.js";

const rl = createInterface({ input, output });

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

async function main() {
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
  output.write("Writing credentials to Cloudflare Worker secrets...\n");
  putSecret("INSTAPAPER_CONSUMER_KEY", consumerKey);
  putSecret("INSTAPAPER_CONSUMER_SECRET", consumerSecret);
  putSecret("INSTAPAPER_OAUTH_TOKEN", tokens.token);
  putSecret("INSTAPAPER_OAUTH_TOKEN_SECRET", tokens.tokenSecret);
  output.write("Instapaper credentials stored. Username/password were not persisted.\n");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Instapaper setup failed.");
    process.exitCode = 1;
  })
  .finally(() => rl.close());
