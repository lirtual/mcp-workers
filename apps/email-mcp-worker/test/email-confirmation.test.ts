import { describe, expect, it } from "vitest";
import {
  confirmationTargetHash,
  createEmailConfirmationCodec,
  emailConfirmation,
  type EmailConfirmationState,
} from "../src/email-confirmation.js";

type Responses = Parameters<typeof emailConfirmation>[1];
type VerifyContext = Parameters<ReturnType<typeof createEmailConfirmationCodec>["verify"]>[1];

function responses(value: unknown): Responses {
  return value as Responses;
}

const codec = createEmailConfirmationCodec("unit-test-portal-token-with-stable-entropy");
const verifyContext = {} as VerifyContext;

describe("Email MCP destructive confirmation", () => {
  it("requests protocol input bound to signed request state", async () => {
    const targetHash = await confirmationTargetHash({
      operation: "trash",
      accountId: "qq",
      folderId: "INBOX",
      messageIds: ["m1", "m2"],
    });
    const expected: EmailConfirmationState = {
      operation: "trash",
      targetHash,
    };

    const decision = await emailConfirmation(
      codec,
      undefined,
      undefined,
      expected,
      "Move 2 messages to Trash?",
    );

    expect(decision.kind).toBe("input_required");
    if (decision.kind !== "input_required") return;
    expect(decision.result).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        email_confirmation: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Move 2 messages to Trash?",
          },
        },
      },
    });
    expect(typeof decision.result.requestState).toBe("string");
    await expect(
      codec.verify(decision.result.requestState!, verifyContext),
    ).resolves.toEqual(expected);
  });

  it("continues only for an accepted checked confirmation on the same target", async () => {
    const expected: EmailConfirmationState = {
      operation: "trash",
      targetHash: "same-target",
    };
    await expect(
      emailConfirmation(
        codec,
        responses({
          email_confirmation: {
            action: "accept",
            content: { confirm: true },
          },
        }),
        expected,
        expected,
        "Trash?",
      ),
    ).resolves.toEqual({ kind: "confirmed" });
  });

  it("denies decline, cancel, and unchecked confirmation", async () => {
    const expected: EmailConfirmationState = {
      operation: "trash",
      targetHash: "same-target",
    };
    for (const value of [
      { email_confirmation: { action: "decline" } },
      { email_confirmation: { action: "cancel" } },
      { email_confirmation: { action: "accept", content: { confirm: false } } },
    ]) {
      await expect(
        emailConfirmation(
          codec,
          responses(value),
          expected,
          expected,
          "Trash?",
        ),
      ).resolves.toMatchObject({ kind: "denied" });
    }
  });
});
