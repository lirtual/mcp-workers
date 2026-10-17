# ssh-mcp-worker context

This application owns the MCP ingress for EdgeSSH host discovery. EdgeSSH remains the source of truth and sole catalog writer. `HostReader` performs fixed, parameterized reads from `workspace_state` and `hosts`, decrypts the pinned v1 payload in memory, and returns only the sanitized `HostView` projection.

`HostView` communicates whether the saved fingerprint and selected credential field are present. It does not claim the host is reachable or that its SSH key has been observed online. `initialCommand` remains stored host data and is never returned or run.

Q22=B requires this Worker to become another credential custodian after separate secret/binding authorization. The D1 binding is not database-enforced read-only. This ticket configures no production database ID, Secret, Portal route or deployment.
