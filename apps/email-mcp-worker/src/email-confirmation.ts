import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const confirmationSchema = z.object({
  confirm: z.boolean().meta({ title: "Confirm email action" }),
});

export interface EmailConfirmationState {
  operation: "trash" | "send" | "respond";
  targetHash: string;
}

export function createEmailConfirmationCodec(secret: string) {
  return createRequestStateCodec<EmailConfirmationState>({
    key: \`email-mcp-worker-v0.1-confirmation:\${secret}\`,
    ttlSeconds: 300,
  });
}

export type EmailConfirmationCodec = ReturnType<
  typeof createEmailConfirmationCodec
>;

export type EmailConfirmationDecision =
  | { kind: "confirmed" }
  | { kind: "denied"; message: string }
  | { kind: "input_required"; result: InputRequiredResult };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function confirmationTargetHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

export async function emailConfirmation(
  codec: EmailConfirmationCodec,
  inputResponses: Parameters<typeof inputResponse>[0],
  state: EmailConfirmationState | undefined,
  expected: EmailConfirmationState,
  message: string,
): Promise<EmailConfirmationDecision> {
  if (
    state?.operation !== expected.operation ||
    state.targetHash !== expected.targetHash
  ) {
    return {
      kind: "input_required",
      result: inputRequired({
        inputRequests: {
          email_confirmation: inputRequired.elicit({
            message,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await codec.mint(expected),
      }),
    };
  }

  const view = inputResponse(inputResponses, "email_confirmation");
  if (view.kind !== "elicit") {
    return {
      kind: "denied",
      message: "The email action confirmation response is missing.",
    };
  }
  if (view.action !== "accept") {
    return {
      kind: "denied",
      message: "The user declined or cancelled the email action.",
    };
  }

  const confirmed = acceptedContent(
    inputResponses,
    "email_confirmation",
    confirmationSchema,
  );
  if (confirmed?.confirm !== true) {
    return {
      kind: "denied",
      message: "The user did not confirm the email action.",
    };
  }

  return { kind: "confirmed" };
}
