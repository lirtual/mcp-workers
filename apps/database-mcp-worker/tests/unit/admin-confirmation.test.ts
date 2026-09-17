import { describe, expect, it } from 'vitest';
import {
  adminConfirmation,
  createAdminConfirmationCodec,
  type AdminConfirmationState
} from '../../src/admin-confirmation.js';

type Responses = Parameters<typeof adminConfirmation>[1];

function responses(value: unknown): Responses {
  return value as Responses;
}

const codec = createAdminConfirmationCodec('unit-test-portal-token-with-stable-entropy');
const dropUsers: AdminConfirmationState = {
  operation: 'drop_table',
  target: 'main:public:users'
};

describe('Safe Admin protocol confirmation', () => {
  it('requests MCP input and binds it to signed request state', async () => {
    const decision = await adminConfirmation(codec, undefined, undefined, dropUsers, 'Drop table public.users?');
    expect(decision.kind).toBe('input_required');
    if (decision.kind !== 'input_required') return;
    expect(decision.result).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        admin_confirmation: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Drop table public.users?'
          }
        }
      }
    });
    expect(typeof decision.result.requestState).toBe('string');
    await expect(codec.verify(decision.result.requestState!)).resolves.toEqual(dropUsers);
  });

  it('continues only after the signed target state and operator confirmation both match', async () => {
    const decision = await adminConfirmation(
      codec,
      responses({ admin_confirmation: { action: 'accept', content: { confirm: true } } }),
      dropUsers,
      dropUsers,
      'Drop table public.users?'
    );
    expect(decision).toEqual({ kind: 'confirmed' });
  });

  it('does not allow a confirmation response to be reused for another target', async () => {
    const decision = await adminConfirmation(
      codec,
      responses({ admin_confirmation: { action: 'accept', content: { confirm: true } } }),
      dropUsers,
      { operation: 'drop_table', target: 'main:public:payments' },
      'Drop table public.payments?'
    );
    expect(decision.kind).toBe('input_required');
  });

  it('denies decline, cancel, and an unchecked confirmation', async () => {
    await expect(
      adminConfirmation(
        codec,
        responses({ admin_confirmation: { action: 'decline' } }),
        dropUsers,
        dropUsers,
        'Drop?'
      )
    ).resolves.toMatchObject({ kind: 'denied' });
    await expect(
      adminConfirmation(
        codec,
        responses({ admin_confirmation: { action: 'cancel' } }),
        dropUsers,
        dropUsers,
        'Drop?'
      )
    ).resolves.toMatchObject({ kind: 'denied' });
    await expect(
      adminConfirmation(
        codec,
        responses({ admin_confirmation: { action: 'accept', content: { confirm: false } } }),
        dropUsers,
        dropUsers,
        'Drop?'
      )
    ).resolves.toMatchObject({ kind: 'denied' });
  });
});
