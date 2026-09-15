export interface Env {
  INSTAPAPER_CONSUMER_KEY: string;
  INSTAPAPER_CONSUMER_SECRET: string;
  INSTAPAPER_OAUTH_TOKEN: string;
  INSTAPAPER_OAUTH_TOKEN_SECRET: string;
  MCP_ORIGIN_TOKEN: string;
}

export function instapaperCredentialsFromEnv(env: Pick<Env,
  | "INSTAPAPER_CONSUMER_KEY"
  | "INSTAPAPER_CONSUMER_SECRET"
  | "INSTAPAPER_OAUTH_TOKEN"
  | "INSTAPAPER_OAUTH_TOKEN_SECRET"
>) {
  return {
    consumerKey: env.INSTAPAPER_CONSUMER_KEY,
    consumerSecret: env.INSTAPAPER_CONSUMER_SECRET,
    oauthToken: env.INSTAPAPER_OAUTH_TOKEN,
    oauthTokenSecret: env.INSTAPAPER_OAUTH_TOKEN_SECRET,
  };
}
