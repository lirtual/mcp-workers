# Browser MCP — context

Browser MCP controls a selected browser Profile through a paired extension, an authenticated Cloudflare Worker and a signed WebSocket connection. A Profile grant is not permission to act on every website; task scope and real page state still matter. The Browser MCP is independent of Remote Control's file/Shell tools.

- Owner activation uses its existing exact-email and Cloudflare SSO/OTP checks. A public download or installed extension alone does not establish an Owner grant. Keep pairing, Owner entrypoint and site-level authority distinct.
- Bind each browser operation to the authorized Profile, session, tab and stable operation intent; never silently retarget based on an array position or stale snapshot.
- Operations with effects use receipts. An Unknown or interrupted operation must be reconciled against its original identity, not blindly replayed. Historical Unknown receipts remain queryable even though the former independent Owner Unknown Review UI has been retired.
- Keep Owner Access, extension signing/pairing, protected endpoint routes, and bundled artifact/version integrity checks. The public extension landing page provides read-only installation assets, not MCP privileges.
- Successful source tests, Worker publication, Portal sync and actual browser acceptance are separate states. A fresh credential, production configuration or release change still requires explicit authorization.

See the [Browser Skill](skills/browsermcp/SKILL.md), code and tests for exact current tool names, input bounds and connection behavior. Current architecture decisions: [Profile vs. business authorization](docs/adr/0002-profile-grant-not-business-authorization.md) and [Unknown Review retirement](docs/adr/0004-retire-owner-unknown-review.md).
