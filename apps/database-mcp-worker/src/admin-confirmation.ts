import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequiredResult
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const confirmationSchema = z.object({
  confirm: z.boolean().meta({ title: 'Confirm destructive schema change' })
});

export interface AdminConfirmationState {
  operation: 'drop_table' | 'drop_index' | 'drop_column';
  target: string;
}

export function createAdminConfirmationCodec(secret: string) {
  return createRequestStateCodec<AdminConfirmationState>({
    key: `database-mcp-worker-v0.3-admin-confirmation:${secret}`,
    ttlSeconds: 300
  });
}

export type AdminConfirmationCodec = ReturnType<typeof createAdminConfirmationCodec>;

export type AdminConfirmationDecision =
  | { kind: 'confirmed' }
  | { kind: 'denied'; message: string }
  | { kind: 'input_required'; result: InputRequiredResult };

export async function adminConfirmation(
  codec: AdminConfirmationCodec,
  inputResponses: Parameters<typeof inputResponse>[0],
  state: AdminConfirmationState | undefined,
  expected: AdminConfirmationState,
  message: string
): Promise<AdminConfirmationDecision> {
  if (state?.operation !== expected.operation || state.target !== expected.target) {
    return {
      kind: 'input_required',
      result: inputRequired({
        inputRequests: {
          admin_confirmation: inputRequired.elicit({
            message,
            requestedSchema: confirmationSchema
          })
        },
        requestState: await codec.mint(expected)
      })
    };
  }

  const view = inputResponse(inputResponses, 'admin_confirmation');
  if (view.kind !== 'elicit') {
    return { kind: 'denied', message: 'The destructive schema confirmation response is missing.' };
  }

  if (view.action !== 'accept') {
    return { kind: 'denied', message: 'The operator declined or cancelled the destructive schema operation.' };
  }

  const confirmed = acceptedContent(inputResponses, 'admin_confirmation', confirmationSchema);
  if (confirmed?.confirm !== true) {
    return { kind: 'denied', message: 'The operator did not confirm the destructive schema operation.' };
  }

  return { kind: 'confirmed' };
}
