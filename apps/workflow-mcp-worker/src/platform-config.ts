/**
 * Trusted, source-controlled executor configuration.
 * Runtime variables carry deployment identity only; OIDC trust anchors and the
 * executor workflow/ref are not sourced from dashboard overrides.
 */
export const GITHUB_EXECUTOR_CONFIG = {
  repository: 'lirtual/mcp-workers',
  repositoryId: '1371085786',
  ref: 'main',
  workflow: 'workflow-executor.yml',
  oidc: {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: 'workflow-mcp-worker',
    jwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks'
  }
} as const;

export const CANONICAL_SCHEDULER_CRON = '* * * * *';
