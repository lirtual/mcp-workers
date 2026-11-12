# SSH MCP

Personal SSH/SFTP MCP using selected EdgeSSH host records and an independent receipt-backed Worker.

The Worker reads (but does not modify) EdgeSSH's existing D1 host data and decrypts approved records in memory using the original shared encryption key. The Cloudflare D1 binding is technically write-capable; it must not be treated as a database-isolation guarantee. Never rotate the shared key without verified migration and recovery.

Remote commands and SFTP changes are real external effects. Recheck host identity and pinning before credentials are used; preserve bounded outputs, operation IDs, historical receipts and **Unknown = no automatic replay**. The [SSH Skill](skills/ssh/SKILL.md) and source tests define the current tool contract.

Production release, Secret configuration and any actual remote write require their own authorization. Source changes and CI are not a deployment.
