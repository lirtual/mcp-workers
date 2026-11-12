# ADR-0014: One signed multi-device relay

Remote Control uses the existing Cloudflare Worker and a Durable Object coordinator for authorized devices. Each paired native Agent connects through authenticated signed WebSocket traffic; authorization is bound to the actual device identity, not a machine name, URL, host-local path or other editable label.

Keep device grants, revocation, connection generations and operation receipts independent of the local Agent execution authority. Connection loss does not establish whether a remote effect completed, and a live Session is not a permanent machine.

No new fleet service, arbitrary private-IP forwarding, general network proxy or second authorization layer is introduced. A code change is not production deployment or new device enrollment. See [Remote Control context](../CONTEXT.md) and the current Worker/Agent tests.
