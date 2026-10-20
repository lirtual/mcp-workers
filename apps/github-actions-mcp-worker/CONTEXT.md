# GitHub Actions MCP context

Owns an independently deployed, stateless MCP ingress for GitHub Actions on an explicit repository allowlist. GitHub is the source of truth for workflows, run states, jobs and artifact metadata. Mutations use GitHub's official dispatch, cancel and rerun endpoints; returned acceptance is not evidence that a run completed.

Session Deck is a separate optional control plane and remains the owner of session-target discovery, exclusive-target admission, workflow input validation, readiness observation, locator artifact parsing and Sensitive Facts decryption. This app only proxies its documented authenticated API after confirming the returned target repo appears in the same configured allowlist. It does not directly attach to GitHub runners or persist session passwords, credentials, or command output.

Boundaries: no arbitrary repo URL, no generic HTTP proxy, no shell access, no unbounded logs or artifact downloads, no Cloudflare deployment actions. The app never logs upstream bodies, secrets, or private facts. No production deployment is performed by a source PR.
