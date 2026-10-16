# Single-Worker v2 Preview acceptance (#53 / #56)

Use **one** existing Worker (`remote-control-v2-preview`) and **one** ChatGPT
plugin. Test on the disposable WSL2 distribution `rc-v2-receipt-lab` as the
unprivileged Linux user `rcagent`. No extra Worker, plugin, Portal key,
per-device Worker secret or hard-coded command/file allowlist.

## Model and essential boundaries

- The Preview Worker advertises normal local file, Shell, managed-session and
  Receipt tools, plus owner device pairing/list/revoke.
- Every device tool call **requires an explicit approved `device_id`**.
  Worker MCP authentication and the device's signed WSS identity are separate.
- Preview routes to `V2_OWNER` only. It must never fall back to the v1 VPC.
- The **Agent** determines available capabilities: the ordinary
  `v2-main.ts` remains `readOnly=true, writeFile=false, shell=false`.
  Unsupported operations are rejected locally. A separate foreground script
  explicitly enables file writes and Shell on the disposable guest.
- Changes require a stable `operation_id`, with original Agent-local Receipt
  persistence and conflict/idempotency checks. After `timeout_unknown` or a
  lost response, query the original `operation_id` — **never blindly retry**.
- This WSL distro must have no Windows/DrvFS mounts and must not run as root.
  WSL is not a VM-grade sandbox: keep the account unprivileged and avoid
  WSL interop, host shares and privileged host credentials.
- ChatGPT may independently decline write/Shell tool calls even if its plugin
  setting says `Allow all actions`; changing Worker code cannot bypass that.

## Test sequence

1. Update the PR #58 checkout of **only** `rc-v2-receipt-lab` and verify CI.
   Deploy **only** `apps/remote-control-mcp-worker/wrangler.v2-preview.jsonc`.
   Never use the v1 production Wrangler config. The Preview has
   `REMOTE_CONTROL_V2_PREVIEW_ONLY=true`, `V2_OWNER` and its existing
   `MCP_ACCESS_TOKEN` — no `REMOTE_CONTROL_V2_RECEIPT_TEST_DEVICE_ID`.
2. Pair/recover the disposable `rc-v2-receipt-test` using the existing Preview
   plugin. Check `list_devices` and read `/etc/os-release` using the explicit
   device ID. **Do not** pair or mutate the ordinary `rc-v2-lab` device.
3. Stop any previous ordinary foreground Agent in the disposable distro
   (Ctrl+C). Confirm the guest and account:

   ```bash
   test "$WSL_DISTRO_NAME" = "rc-v2-receipt-lab"
   findmnt -rn -t drvfs  # expected: no output
   sudo -u rcagent -H env WSL_DISTRO_NAME="$WSL_DISTRO_NAME" bash -c '
     cd /home/rcagent/mcp-workers-v2-receipt-lab || exit 1
     exec node --experimental-strip-types \
       apps/remote-control-agent/scripts/v2-preview-receipt-foreground.mjs
   '
   ```

   The dedicated script refuses root, non-test distro, Windows mounts, unsafe
   identity files or a competing systemd Agent; it runs foreground for **at
   most 12 minutes**, with Ctrl+C available for immediate stop.
4. Confirm `preview-receipt-test: connected` and the exact device ID online.
   Test on a harmless fresh path under `/home/rcagent`: an initial
   `write_file` with `mode=append`, then `get_operation_status` and a read
   of the file. Re-submit only a **known completed** same-ID call for the
   idempotency check, and verify no duplicate append. Reuse that ID with
   changed content to assert `conflict`; use a new ID for a new operation.
   Separately test a harmless `run_command` such as `printf receipt-ok`,
   then query the Receipt, session ID and bounded output. Do not use destructive
   commands for acceptance.
5. If the ChatGPT app blocks a mutation **before execution**, do not evade its
   safety boundary or claim an E2E pass. Record the actual blocked call and
   complete the remaining non-mutating checks.
6. End with Ctrl+C, check `rc-v2-receipt-test` offline and ordinary
   `rc-v2-lab` still online/readable. No Cloudflare capability secret needs
   creating or deleting: the test Agent being stopped ends its Shell access.

The basic acceptance does not establish true lost-after-commit WSS response
handling, sustained hibernation reliability, or the #57 72-hour soak. Keep
those gates open until there is evidence. Do not treat a unit/integration test
as a real-device mutation E2E result.
