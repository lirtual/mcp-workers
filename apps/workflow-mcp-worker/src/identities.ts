async function digest(seed: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function makeStepIdentity(
  runId: string,
  stepId: string
): Promise<{ stepRunId: string; operationId: string }> {
  const value = (await digest(`${runId}:step:${stepId}`)).slice(0, 32);
  return {
    stepRunId: `step_${value}`,
    operationId: `op_${value}`
  };
}

export async function makeAttemptId(stepRunId: string, attemptNumber: number): Promise<string> {
  return `att_${(await digest(`${stepRunId}:attempt:${attemptNumber}`)).slice(0, 32)}`;
}
