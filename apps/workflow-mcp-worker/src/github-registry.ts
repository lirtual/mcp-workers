// Source allow-list. Definitions cannot choose a repository, ref, workflow
// file, or token. Dispatch builds the GitHub URL from this object only.
export const REGISTERED_GITHUB_ACTION = {
  id: 'github.action.registered',
  repository: 'lirtual/mcp-workers',
  repositoryId: '1414936394',
  workflow: 'registered-action.yml',
  ref: 'refs/heads/main',
  audience: 'workflow-github-action:registered',
  grant: 'approve_heavy_execution',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['subject'],
    properties: {
      subject: {type: 'string', minLength: 1, maxLength: 80},
    },
  },
} as const;

const SUBJECT = /^[^\u0000-\u001f\u007f]{1,80}$/;

export function registeredWorkflowRef(): string {
  const action = REGISTERED_GITHUB_ACTION;
  return action.repository + '/.github/workflows/' + action.workflow + '@' + action.ref;
}

export function registeredPlanPin() {
  const action = REGISTERED_GITHUB_ACTION;
  return {
    repository: action.repository,
    repository_id: action.repositoryId,
    workflow: action.workflow,
    ref: action.ref,
  };
}

export function registeredSubject(value: string): boolean {
  return SUBJECT.test(value);
}

export function parseRegisteredInputs(value: unknown): {subject: string} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.subject !== 'string' || !registeredSubject(record.subject))
    return null;
  return {subject: record.subject};
}

export function registeredGithubPin(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pin = value as Record<string, unknown>;
  const expected = registeredPlanPin();
  return Object.keys(pin).length === 4
    && pin.repository === expected.repository
    && pin.repository_id === expected.repository_id
    && pin.workflow === expected.workflow
    && pin.ref === expected.ref;
}
