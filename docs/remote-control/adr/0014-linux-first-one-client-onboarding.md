# ADR-0014 — Linux-first install scope and optional Cloudflare One Client automation

Status: **accepted for future multi-device installer scope only**. Date: 2026-10-14. Decision inputs: grilling Q1=A (installer may automatically handle Cloudflare One Client), Q2=A (Linux + WSL2 first).

## Context

Remote Control MCP v1 already runs a native Node.js Linux Agent behind a single VPC Service and outbound Tunnel. The next product goal is simple, user-initiated installation of additional owned devices on unrelated home, office and cloud-server networks without device public IPs or manual inbound port forwarding. The owner wants to avoid per-device Cloudflare setup and manual device secret copying.

A transport design **has not been chosen**: Cloudflare Mesh + Workers VPC Network and an Agent-initiated WebSocket + Durable Objects relay are still candidates. The existing production topology must remain unchanged during design work.

## Decisions

1. **Q1=A — Installation UX**: A future installer **may install and configure Cloudflare One Client automatically** where supported; the user should not need to repeat Cloudflare control-plane configuration manually on every device. Installing software does **not** itself grant enrollment/remote control, and the installer must not silently add a device using a reusable shared cloud-administrator key. User authorization/enrollment is a separate unresolved decision.
2. **Q2=A — Initial operating systems**: Deliver a **Linux-first installer covering Linux hosts and WSL2 Linux Agent environments**. Native Windows and macOS execution are deferred to later work; the existence of platform-specific transport clients does not imply support for native execution tools.
3. **WSL2 networking constraint**: Cloudflare's documented support is via the **Cloudflare One Client on the Windows host**, not a separate One Client installed inside WSL2. The installer design must test Windows-host to WSL2-Agent connectivity and network/firewall behavior; do not assume a host-level Mesh IP can reach a loopback-only Linux process.
4. **Linux server enrollment constraint**: Cloudflare provides headless enrollment using Service Auth managed deployment. This is a candidate mechanism only. The installer must not embed a persistent shared service token in a public command, script, repository, command-line arguments or logs; how secure per-device onboarding is performed remains open.
5. Maintain **one MCP ingress** as the intended product experience. Continue to treat machine identity, requested target device and OS execution scope separately.
6. This ADR neither changes the existing v1 accepted single-device VPC/Tunnel design (ADR-0004), separate device authentication (ADR-0012), nor the Linux Agent implementation (ADR-0013). It authorizes **no** deployment, installer execution, Cloudflare resource changes, production secret changes, or CI additions.

## Consequences and trade-offs

**Benefits:** Linux Agent reuse avoids prematurely implementing different Windows/macOS Shell and process supervision contracts; allowing One Client installation keeps Cloudflare Mesh + VPC Network viable, so the design need not default to building a custom WebSocket broker.

**Costs:** WSL2 installation is a cross-OS workflow involving the Windows host and a Linux runtime; privileged package/client installation and a user-approved enrollment step may prevent a fully silent setup. Headless cloud hosts need a secure enrollment path that does not distribute long-lived broad-scoped credentials. A separate One Client can also affect a host's network behavior and must be detected and preserved if already configured.

## Next design gates (unresolved, not approved)

- Pairing UX for interactive devices versus headless cloud servers, and when the owner must explicitly approve a new device.
- Whether Mesh enrollment suffices for transport identity and how separate Remote Control MCP Agent authorization is provisioned, rotated and revoked.
- Route and identity registry: trusted device_id -> current private endpoint, default selection, disconnected state, and rejection of arbitrary destination IP/ports.
- Per-device revoke/remove, local uninstall, restart recovery, in-flight mutation reconciliation and return-to-v1 rollback.
- An offline proof with one Linux host and one WSL2 environment, checking both successful allowed operations and denied unauthorized access. Compare viable Mesh and WS + DO options before deciding the transport ADR.

## Primary Cloudflare references

- [Cloudflare One Client lifecycle: WSL2 uses the Windows host client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/support-lifecycle/)
- [Headless Linux One Client deployment](https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/)
- [Connect Mesh client devices](https://developers.cloudflare.com/mesh/guides/connect-client-devices/)
- [Connect Workers to Cloudflare Mesh](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/)
