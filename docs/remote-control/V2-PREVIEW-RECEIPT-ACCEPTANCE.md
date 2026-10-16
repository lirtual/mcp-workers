# Single-Worker v2 Preview Receipt acceptance (#53 / #56)

Keep **one** v2 Worker and one ChatGPT connection:
`remote-control-v2-preview`. The former disposable
`remote-control-v2-receipt-lab` Worker/DO has been deleted.
This is an **opt-in experiment**; normal Preview devices remain read-only.

## Server-side safeguard

- Preview continues to use `REMOTE_CONTROL_V2_PREVIEW_ONLY=true`,
  `V2_OWNER` and the unchanged `MCP_ACCESS_TOKEN`. It has no v1 VPC binding.
- **Default** (no grant): original read-only tools only.
- **Temporary explicit grant**: set the Preview Worker **secret**
  `REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID` to the UUID of *one*
  newly paired disposable, unprivileged test device.
- Only this matching `device_id` can call `write_file`,
  `get_operation_status`, `run_command`, `list_sessions`, or
  `read_session_output`. For other device IDs, forged tools/call requests
  must be refused **before DO dispatch**. No delete/move/interactive Shell.
- The existing v2 Agent systemd entry remains
  `readOnly=true, writeFile=false, shell=false`. The temporary test script
  below explicitly enables operations for at most 12 minutes.

Do **not** repurpose an already paired personal/production device, use the
ordinary v1 Worker release script, change the existing Preview Portal token,
or attempt Shell tests in a WSL distro with mounted Windows drives.
A WSL2 distro is not a VM-grade security sandbox.

## Operator sequence

1. Verify Draft PR #58 CI, with the absence of the grant in the deployed
   configuration. Deploy **only the Preview** using the dedicated
   `apps/remote-control-mcp-worker/wrangler.v2-preview.jsonc` from the
   reviewed checkout. Do not deploy or merge the production
   `wrangler.jsonc` configuration; no GitHub CI workflow is added.
2. In the disposable `rc-v2-receipt-lab` WSL distro, ensure the former Lab
   *foreground* Agent was stopped (Ctrl+C) and `findmnt -rn -t drvfs`
   prints nothing. The deleted Lab device's identity is not a Preview key.
   **Archive** the old Lab PEM and device-id under an owner-only directory,
   not in the new Preview identity path:

   ```bash
   sudo -u rcagent -H bash -c '
   set -e; umask 077
   dir="$HOME/.local/share/mcp-workers/remote-control"
   install -d -m 700 "$dir/archived-deleted-lab"
   test -f "$dir/v2-identity.pem" && test -f "$dir/v2-identity.pem.device-id"
   mv "$dir/v2-identity.pem" "$dir/archived-deleted-lab/"
   mv "$dir/v2-identity.pem.device-id" "$dir/archived-deleted-lab/"
   '
   ```

3. Run the normal v2 installer for the **existing Preview endpoint**, using
   `rcagent` and `--foreground` with label `rc-v2-receipt-test`.
   In the **same existing ChatGPT v2 Preview plugin** perform
   `pairing_lookup` and `pairing_prepare`. Enter the short-lived challenge
   only in the test-device terminal. This first connection is still read-only.
   Check the new Preview device via the same plugin's `list_devices` and
   explicit-device `read_file`. If the device is offline, stop here.
4. In the WSL administrator account's approved checkout, add the new UUID
   as `REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID` using
   `wrangler secret put` with `wrangler.v2-preview.jsonc` (never put
   the ID in Git or use an existing user's device UUID).
   Verify the same plugin can see the limited new tools after a normal tool
   catalog refresh or reconnect; **do not add a second plugin**.
   Check that the existing production/read-only device IDs cannot mutate.
5. Ctrl+C to stop the read-only foreground Agent. In a separate shell as
   unprivileged `rcagent` run
   `node --experimental-strip-types apps/remote-control-agent/scripts/v2-preview-receipt-foreground.mjs`
   from its own reviewed checkout. A maximum 12-minute timer and Ctrl+C
   both end the privileged test.
6. Through the original v2 Preview plugin, use ONLY a unique harmless
   fixture path under `/home/rcagent/`, unique stable operation IDs and
   `write_file` with `mode=append`. Verify exactly one append for same ID,
   conflict on changed arguments, `get_operation_status` completed, and
   a fixed benign `printf` `run_command` whose duplicate reuses its
   session. No arbitrary commands or access to user workspaces.
   If a mutation responds `timeout_unknown` or transport fails,
   **do not retry it**; query its original operation_id.
7. Immediately stop the foreground test Agent and delete the temporary
   `REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID` **Preview secret**, which
   removes the ability to advertise/route write/Shell from the Preview.
   Verify `tools/list` is read-only again, the normal v2 devices still
   work, and production v1 remains unchanged. The new Preview test device
   may be explicitly revoked **only after test completion**.

The simple acceptance above does **not** test a true lost-after-commit WSS
response, multi-device isolation with two test devices, hibernation under
sustained load, or the #57 72-hour soak. Keep those items open until proven.
Do not claim a non-mutating read establishes Receipt behavior.
