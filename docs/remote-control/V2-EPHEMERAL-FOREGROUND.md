# Remote Control v2 — ephemeral Linux foreground Agent

For **disposable, non-systemd Linux containers** (PID 1 may be `tini`), use the existing v2 installer **with `--foreground`**. This is a limited connectivity test, **not** T09's persistent systemd deployment or T11's five-device 72-hour soak.

Requirements: **Node.js 24**, non-root Linux user, `cc`, writable private Linux home, current `feat/remote-control-v2-46` checkout, and an actual **interactive TTY** for first pairing. No Portal Bearer or Cloudflare administrative secret belongs on the Agent. The installer compiles the same C supervisor as the systemd path and preserves 0600 private identity files.

```sh
node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs \
  --foreground \
  --endpoint https://remote-control-v2-preview.aiyaya.workers.dev/ \
  --name grokbot
```

The device displays a **10-character pairing code** in the default terminal UX; add `--show-fingerprint` for optional local/public-key visual comparison without an extra `openssl` command. The MCP performs its existing immutable fingerprint binding via `pairing_lookup` → `pairing_prepare`; the owner separately and **personally authorizes** challenge entry on the intended terminal. The local device then signs the challenge. After successful pairing, the installer starts the **same** `src/v2-main.ts` Agent **in the foreground**. Only `readOnly: true` is enabled; Shell and writes stay disabled. There is **no systemd unit, daemon, nohup, PM2, startup task, Windows helper, v1 credential or auto-restart process**.

If the terminal/session closes, the container is suspended, or the environment is wiped, the Agent goes offline once network failure is observed. An ordinary reconnect while the process remains alive uses bounded backoff. If a container is resumed with its **original key + device ID**, restart manually:

```sh
node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs \
  --foreground --resume \
  --endpoint https://remote-control-v2-preview.aiyaya.workers.dev/
```

`--foreground --upgrade` and `--foreground --uninstall` are intentionally unsupported. There is no installed service to manage. Foreground mode rejects an existing v2 systemd unit to avoid running two Agents for one key. On complete disk wipe, identity recovery is **not automatic**: the owner must **revoke_device** the previous device using the authenticated preview MCP and separately enroll a *new* identity. Never copy private keys between test agents.

**Security boundary for Grokbot:** if an autonomous model is controlling the same terminal into which the pairing challenge is entered, that alone does **not** demonstrate independent human presence for #47. A successful pairing can verify *technical* Ed25519 and WSS behavior but does not close the actual owner-consent security acceptance. MCP-only fingerprint matching does not prove which physical host the owner intended. The owner must explicitly authorize entering the challenge on the target device; manual local fingerprint comparison is optional, do not have the model automatically prepare and submit both sides without owner review.

Check actual availability from the authenticated ChatGPT v2 Preview plugin using `list_devices` and a harmless `read_file` with explicit `device_id`. No hosted 72-hour reliability, Windows reboot or production migration is implied. PR #58 remains Draft; existing v1 stays unchanged.
