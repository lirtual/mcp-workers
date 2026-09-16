# Workspace dependency resolution audit

- Node: `24`
- pnpm: `10.17.1`
- Candidate generated from the six unchanged app manifests.
- IMA comparison source: migrated `package-lock.json`.
- Raindrop comparison source: migrated `bun.lock`.
- npm aliases are compared by resolved target version rather than package-manager display syntax.
- Direct dependency rows checked: **53**; changed: **0**.

| App | Package | Previous lock | pnpm workspace | Result |
| --- | --- | --- | --- | --- |
| IMA | @cloudflare/workers-types | 5.20260911.1 | 5.20260911.1 | same |
| IMA | @modelcontextprotocol/server | 2.0.0 | 2.0.0 | same |
| IMA | agents | 0.20.1 | 0.20.1 | same |
| IMA | typescript | 6.0.3 | 6.0.3 | same |
| IMA | wrangler | 4.131.0 | 4.131.0 | same |
| IMA | zod | 4.6.2 | 4.6.2 | same |
| Raindrop | @anthropic-ai/dxt | 0.2.6 | 0.2.6 | same |
| Raindrop | @eslint/js | 10.0.1 | 10.0.1 | same |
| Raindrop | @modelcontextprotocol/client | 2.0.0-beta.5 | 2.0.0-beta.5 | same |
| Raindrop | @modelcontextprotocol/inspector | 1.0.0 | 1.0.0 | same |
| Raindrop | @modelcontextprotocol/node | 2.0.0-beta.5 | 2.0.0-beta.5 | same |
| Raindrop | @modelcontextprotocol/sdk | 1.29.0 | 1.29.0 | same |
| Raindrop | @modelcontextprotocol/server | 2.0.0-beta.5 | 2.0.0-beta.5 | same |
| Raindrop | @openapitools/openapi-generator-cli | 2.40.0 | 2.40.0 | same |
| Raindrop | @semantic-release/changelog | 7.0.0 | 7.0.0 | same |
| Raindrop | @semantic-release/commit-analyzer | 13.0.1 | 13.0.1 | same |
| Raindrop | @semantic-release/exec | 7.1.0 | 7.1.0 | same |
| Raindrop | @semantic-release/git | 11.0.0 | 11.0.0 | same |
| Raindrop | @semantic-release/github | 12.0.9 | 12.0.9 | same |
| Raindrop | @semantic-release/npm | 13.1.5 | 13.1.5 | same |
| Raindrop | @semantic-release/release-notes-generator | 14.1.1 | 14.1.1 | same |
| Raindrop | @types/bun | 1.3.14 | 1.3.14 | same |
| Raindrop | @types/express | 5.0.6 | 5.0.6 | same |
| Raindrop | @types/node | 26.1.1 | 26.1.1 | same |
| Raindrop | @types/supertest | 7.2.1 | 7.2.1 | same |
| Raindrop | @typescript-eslint/eslint-plugin | 8.65.0 | 8.65.0 | same |
| Raindrop | @typescript-eslint/parser | 8.65.0 | 8.65.0 | same |
| Raindrop | @typescript/native | typescript@7.0.2 | 7.0.2 | same |
| Raindrop | @vitest/coverage-v8 | 4.1.10 | 4.1.10 | same |
| Raindrop | axios | 1.18.1 | 1.18.1 | same |
| Raindrop | dotenv | 17.4.2 | 17.4.2 | same |
| Raindrop | eslint | 10.7.0 | 10.7.0 | same |
| Raindrop | eslint-config-prettier | 10.1.8 | 10.1.8 | same |
| Raindrop | esm | 3.2.25 | 3.2.25 | same |
| Raindrop | express | 5.2.1 | 5.2.1 | same |
| Raindrop | husky | 9.1.7 | 9.1.7 | same |
| Raindrop | keyv | 5.6.0 | 5.6.0 | same |
| Raindrop | lint-staged | 17.1.1 | 17.1.1 | same |
| Raindrop | openai | 6.48.0 | 6.48.0 | same |
| Raindrop | openapi-fetch | 0.17.0 | 0.17.0 | same |
| Raindrop | openapi-typescript | 7.13.0 | 7.13.0 | same |
| Raindrop | prettier | 3.9.6 | 3.9.6 | same |
| Raindrop | rate-limiter-flexible | 11.2.0 | 11.2.0 | same |
| Raindrop | semantic-release | 25.0.8 | 25.0.8 | same |
| Raindrop | simple-oauth2 | 5.1.0 | 5.1.0 | same |
| Raindrop | supertest | 7.2.2 | 7.2.2 | same |
| Raindrop | typedoc | 0.28.20 | 0.28.20 | same |
| Raindrop | typescript | 6.0.3 | 6.0.3 | same |
| Raindrop | typescript-eslint | 8.65.0 | 8.65.0 | same |
| Raindrop | vitest | 4.1.10 | 4.1.10 | same |
| Raindrop | vitest-mock-extended | 5.1.0 | 5.1.0 | same |
| Raindrop | zod | 4.4.3 | 4.4.3 | same |
| Raindrop | zod-to-json-schema | 3.25.2 | 3.25.2 | same |
