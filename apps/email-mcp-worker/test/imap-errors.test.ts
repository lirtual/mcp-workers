import { describe, expect, it } from "vitest";
import { normalizeImapError } from "../src/imap-smtp-provider.js";

describe("normalizeImapError diagnostics", () => {
  it("surfaces only bounded provider metadata for unknown IMAP failures", () => {
    const error = normalizeImapError({
      code: "econnreset",
      responseStatus: "BAD",
      responseCode: "CLIENTBUG",
      command: "UID FETCH",
      responseText: "must not be surfaced",
    });

    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.details).toEqual({
      provider_code: "ECONNRESET",
      response_status: "BAD",
      response_code: "CLIENTBUG",
      command: "UID FETCH",
    });
    expect(JSON.stringify(error.details)).not.toContain("must not be surfaced");
  });
});
