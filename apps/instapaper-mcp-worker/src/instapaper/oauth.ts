import { createHmac } from "node:crypto";
import OAuth from "oauth-1.0a";
import type { OAuthTokens, XAuthCredentials } from "./types.js";
import { InstapaperAuthError } from "./errors.js";

export interface SignedRequest {
  headers: Record<string, string>;
  body?: string;
}

export function createOAuthClient(consumerKey: string, consumerSecret: string) {
  return new OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString: string, key: string) {
      return createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

export function signFormRequest(options: {
  url: string;
  method?: "POST" | "GET";
  consumerKey: string;
  consumerSecret: string;
  token?: OAuthTokens;
  params?: Record<string, string>;
}): SignedRequest {
  const method = options.method ?? "POST";
  const params = options.params ?? {};
  const oauth = createOAuthClient(options.consumerKey, options.consumerSecret);
  const requestData = {
    url: options.url,
    method,
    data: params,
  };
  const token = options.token
    ? { key: options.token.token, secret: options.token.tokenSecret }
    : undefined;
  const authData = oauth.authorize(requestData, token);
  const oauthHeader = oauth.toHeader(authData).Authorization;

  return {
    headers: {
      Authorization: oauthHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? new URLSearchParams(params).toString() : undefined,
  };
}

export async function exchangeXAuth(
  credentials: XAuthCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const url = "https://www.instapaper.com/api/1/oauth/access_token";
  const params = {
    x_auth_username: credentials.username,
    x_auth_password: credentials.password ?? "",
    x_auth_mode: "client_auth",
  };
  const signed = signFormRequest({
    url,
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    params,
  });

  const response = await fetchImpl(url, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
  });
  if (!response.ok) {
    throw new InstapaperAuthError(`Instapaper xAuth failed with HTTP ${response.status}.`, response.status);
  }

  const values = new URLSearchParams(await response.text());
  const token = values.get("oauth_token");
  const tokenSecret = values.get("oauth_token_secret");
  if (!token || !tokenSecret) {
    throw new InstapaperAuthError("Instapaper xAuth response did not contain OAuth tokens.");
  }

  return { token, tokenSecret };
}
