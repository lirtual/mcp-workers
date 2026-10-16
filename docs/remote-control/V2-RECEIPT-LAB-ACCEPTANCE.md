# Remote Control v2 · isolated Receipt lab (#53 / #56)

**Draft test plan only. The lab is not automatically deployed, paired or enabled.**
Production v1 and the already-running `remote-control-v2-preview` remain untouched.
All instructions below refer to a **new, disposable WSL2 distribution**, not
`rc-v2-lab`, `Debian-1`, the Windows host, or a production Agent.

## Deliberately small isolation boundary

| Component | Receipt lab | Existing Preview |
| --- | --- | --- |
| Worker name | `remote-control-v2-receipt-lab` | `remote-control-v2-preview` |
| MCP credential | New, unique `MCP_ACCESS_TOKEN` secret | Unchanged |
| Durable Object | Own script export `V2OwnerCoordinator`, own namespace and devices | Unchanged |
| VPC / v1 device binding | **Absent** | Absent |
| RPC tools | Explicit-device read, write, receipt, short test command, bounded session reads | Read-only + owner controls |
| Local Agent | New Ed25519 key in a disposable guest; opt-in foreground only | Installed read-only service |
| Shell / filesystem | Under a disposable unprivileged guest user only | Shell and mutation disabled |

The lab is **not a security sandbox**. Even a small fixed tool list can write files
or start a command with the Agent account's full Linux permissions. The MCP
credential must be private and unique; do not put it in GitHub or chat. A separate
Worker by itself cannot isolate the host filesystem.

Use only a *fresh disposable WSL2 distro* (proposed name `rc-v2-receipt-lab`) with
**Windows-drive automount disabled**, no source mounts, no SSH access and no copied
device keys or credentials from other distros. Confirm `findmnt -t drvfs` shows
no mounted Windows drives before enabling Shell. Do not use a privileged Linux
account. Create only a harmless fixture under that guest's Linux home directory.
Do not run mutable tests on `/mnt/c`, `/mnt/wsl`, or a personal workspace.

## Gate 1 · CI and Cloudflare boundary

1. Review Draft PR #58 and require CI to pass, including `v2-preview-config.test.mjs`
   and the dry-run checks for both `wrangler.v2-receipt-lab*.jsonc` files.
2. The lab config is a *separate Worker* with only
   `REMOTE_CONTROL_V2_RECEIPT_LAB_ONLY=true`, `V2_OWNER`, and a required
   `MCP_ACCESS_TOKEN`. **Never** set this flag on either existing Worker.
3. Bootstrap the new Worker/DO through its dedicated bootstrap config, set a
   newly generated lab-only `MCP_ACCESS_TOKEN`, and deploy the lab release
   config. Never copy the existing Preview Portal token, Cloudflare Tunnel
   credentials or any production secret. Never substitute the production
   `wrangler.jsonc` configuration.
4. Verify the new endpoint returns only the restricted lab tool list. In
   particular, `delete_file`, `move_file`, `send_input` and `stop_session`
   must not be accessible, even via a handcrafted tools/call.
5. Configure the new **lab endpoint as a separate authenticated MCP connection**
   (if needed for live tool invocations). Do not repoint the existing Preview
   connector and do not expose its token.

This stage creates external resources and therefore requires an explicit,
scoped operator action; CI dry-run never deploys anything.

## Gate 2 · new disposable Linux identity

1. Only in the new disposable WSL2 distribution, confirm Node 24, compiler,
   util-linux `flock`, systemd and a Linux home directory, with Windows
   automount truly disabled.
2. Clone/review the PR branch in a *separate* Linux home. Run the ordinary v2
   installer against **only the lab Worker** to obtain an independent key/ID.
3. Pair through the lab MCP's `pairing_lookup` / `pairing_prepare`, with the
   owner typing the one-use 12-character challenge on the local guest terminal.
   Verify an explicit-device read.
4. Stop only this lab distro's `remote-control-v2-agent.service` before
   starting the test foreground Agent. It is **never** appropriate to edit
   `v2-main.ts` or its permanent systemd unit to enable Shell.

For the short, owner-approved test window, use a single foreground Node
invocation inside the *disposable guest*, not an enabled background service:

```bash
cd ~/mcp-workers-v2-receipt-lab
systemctl --user stop remote-control-v2-agent.service
node --experimental-strip-types --input-type=module <<'NODE'
import os from 'node:os';
import path from 'node:path';
import { maintainAuthenticatedDeviceSession } from './apps/remote-control-agent/src/v2-connection-lifecycle.ts';

const endpoint = 'https://remote-control-v2-receipt-lab.aiyaya.workers.dev/';
const key = path.join(os.homedir(), '.local/share/mcp-workers/remote-control/v2-identity.pem');
const done = new AbortController();
process.on('SIGINT', () => done.abort());
process.on('SIGTERM', () => done.abort());
await maintainAuthenticatedDeviceSession(endpoint, key, done.signal, {
  readOnly: true,
  writeFile: true,
  shell: true,
});
NODE
```

**Use Ctrl+C to end this test**. In the disposable guest, restore read-only
state with `systemctl --user start remote-control-v2-agent.service` *only if
the distro remains in active test use*. Disabling/moving lab tests to an ordinary
Preview device is forbidden.

## Gate 3 · actual receipt acceptance (never blind retry)

With a uniquely named fixture file in the disposable guest's home, test:

1. `write_file` append once using a stable `operation_id`; read fixture.
   Repeat the same operation ID and *identical intent*. File remains one append.
   Same ID with changed payload returns `conflict`.
2. `get_operation_status` using the same device ID and operation ID returns
   the persisted `completed` receipt. An unknown ID returns `not_found`.
3. `run_command` may run **only a harmless fixed `printf` in the disposable
   guest**, with a stable operation ID. Duplicate ID reuses the same session;
   changed command conflicts. Do not run arbitrary shell experiments, especially
   never `sudo`, service commands, download scripts, or host filesystem writes.
4. A bounded, controlled fault injection **after execution but before the
   cloud response** must yield `timeout_unknown`. On reconnect, query
   `get_operation_status` with the same ID and ensure the original fixture
   appears exactly once. Do not create a new operation ID or automatically
   replay a write to simulate recovery.
5. Verify offline, wrong `device_id`, unauthorized MCP, no `operation_id`,
   and cross-device receipt isolation (second device only if independently
   provisioned). An offline result must not execute any work.

The initial remote append and Shell tests alone do not prove fault injection,
cross-device isolation, or 72-hour hibernation. Keep untested acceptance
checkboxes **open**.

## Teardown / rollback

Stop the foreground test Agent; keep all real machines and production v1
running. Revoke **only the lab device IDs**. Disconnect the separate lab MCP
connection, delete **only** `remote-control-v2-receipt-lab` and its lab-only
namespace/resources after confirming identifiers, remove the disposable WSL2
distribution only after user confirmation, and verify Preview read-only tools
and production v1 still work. No automatic destruction, blanket
`wsl --shutdown`, or production credential changes are authorized by this doc.
