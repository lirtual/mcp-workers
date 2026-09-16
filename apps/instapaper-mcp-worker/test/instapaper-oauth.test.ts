import { describe, expect, it } from "vitest";
import { signFormRequest } from "../src/instapaper/oauth.js";

describe("Instapaper OAuth signing", () => {
  it("puts OAuth parameters in Authorization and API parameters in the form body", () => {
    const signed = signFormRequest({
      url: "https://www.instapaper.com/api/1/bookmarks/star",
      consumerKey: "consumer",
      consumerSecret: "secret",
      token: { token: "token", tokenSecret: "token-secret" },
      params: { bookmark_id: "123" },
    });

    expect(signed.headers.Authorization).toMatch(/^OAuth /);
    expect(signed.headers.Authorization).toContain("oauth_consumer_key");
    expect(signed.headers.Authorization).toContain("oauth_signature");
    expect(signed.body).toBe("bookmark_id=123");
    expect(signed.body).not.toContain("oauth_signature");
  });
});
