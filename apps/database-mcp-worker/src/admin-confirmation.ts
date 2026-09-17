import { acceptedContent, inputRequired, inputResponse, type InputRequiredResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const confirmationSchema = z.object({
  confirm: z.boolean().meta({ title: 'Confirm destructive schema change' })
});

export type AdminConfirmationDecision =
  | { kind: 'confirmed' }
  | { kind: 'denied'; message: string }
  | { kind: 'input_required'; result: InputRequiredResult };

export function adminConfirmation(
  inputResponses: Parameters<typeof inputResponse>[0],
  message: string
): AdminConfirmationDecision {
  const view = inputResponse(inputResponses, 'admin_confirmation');
  if (view.kind !== 'elicit') {
    return {
      kind: 'input_required',
      result: inputRequired({
        inputRequests: {
          admin_confirmation: inputRequired.elicit({
            message,
            requestedSchema: confirmationSchema
          })
        }
      })
    };
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
