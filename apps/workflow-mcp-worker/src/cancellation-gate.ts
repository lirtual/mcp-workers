import type { RunState } from './storage.js';

export function cancellationBlocksNewStep(state: RunState): boolean {
  return state === 'cancel_requested' || state === 'cancelled';
}
