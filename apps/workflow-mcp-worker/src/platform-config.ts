/**
 * Trusted, source-controlled executor configuration.
 * Runtime variables contain deployment identity only; no OIDC trust setting is
 * sourced from mutable Cloudflare dashboard variables in production.
 */
export const GITHUB_EXECUTOR_CONFIG = {
  ref: 'main',
  workflow: 'workflow-executor.yml',
  oidc: {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: 'workflow-mcp-worker',
    jwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks'
  }
} as const;
