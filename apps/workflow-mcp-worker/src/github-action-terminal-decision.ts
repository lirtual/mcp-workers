import type { PhysicalRunState } from './github-action-run-state.ts';

export type PhysicalTerminalDecision =
 | {kind:'terminal';outcome:'succeeded'|'failed'|'cancelled';conclusion:string}
 | {kind:'hold';reason:'not_terminal'|'identity_unconfirmed'|'ambiguous_conclusion'};

/**
 * No database mutation here. The eventual D1 CAS must recheck the same
 * physical identity, expected attempt and live business state atomically.
 */
export function decidePhysicalGitHubTerminal(state:PhysicalRunState):PhysicalTerminalDecision {
 if(state.state==='identity_mismatch')return {kind:'hold',reason:'identity_unconfirmed'};
 if(state.state==='unknown'||state.state==='queued'||state.state==='running')
   return {kind:'hold',reason:'not_terminal'};
 if(state.conclusion==='success')return {kind:'terminal',outcome:'succeeded',conclusion:'success'};
 if(state.conclusion==='cancelled')return {kind:'terminal',outcome:'cancelled',conclusion:'cancelled'};
 if(state.conclusion==='failure'||state.conclusion==='timed_out')
   return {kind:'terminal',outcome:'failed',conclusion:state.conclusion};
 // Neutral, skipped, action_required or stale is not positive proof of a
 // completed business result. Retain the attempt for explicit reconciliation.
 return {kind:'hold',reason:'ambiguous_conclusion'};
}
