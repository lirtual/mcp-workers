import { describe, expect, it } from 'vitest';
import { adminConfirmation } from '../../src/admin-confirmation.js';

type Responses = Parameters<typeof adminConfirmation>[0];

function responses(value: unknown): Responses {
  return value as Responses;
}

describe('Safe Admin protocol confirmation', () => {
  it('requests MCP input when no operator response is present', () => {
    const decision = adminConfirmation(undefined, 'Drop table app.users?');
    expect(decision.kind).toBe('input_required');
    if (decision.kind !== 'input_required') return;
    expect(decision.result).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        admin_confirmation: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Drop table app.users?'
          }
        }
      }
    });
  });

  it('continues only after the operator accepts and explicitly confirms', () => {
    const decision = adminConfirmation(
      responses({ admin_confirmation: { action: 'accept', content: { confirm: true } } }),
      'Drop table app.users?'
    );
    expect(decision).toEqual({ kind: 'confirmed' });
  });

  it('denies decline, cancel, and an unchecked confirmation', () => {
    expect(
      adminConfirmation(responses({ admin_confirmation: { action: 'decline' } }), 'Drop?').kind
    ).toBe('denied');
    expect(
      adminConfirmation(responses({ admin_confirmation: { action: 'cancel' } }), 'Drop?').kind
    ).toBe('denied');
    expect(
      adminConfirmation(
        responses({ admin_confirmation: { action: 'accept', content: { confirm: false } } }),
        'Drop?'
      ).kind
    ).toBe('denied');
  });
});
