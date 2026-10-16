# Remote Control v2 standalone Agent: initial host gate (#70)

This gate does not authorize installing or publishing a GitHub Release.

- Linux **x86_64 or ARM64**, non-root, **glibc >= 2.28** for the planned bundled Node 24 distribution. musl and other libc variants are unverified and refused.
- Kernel **6.9+**, followed by an actual nonprivileged pidfd process-group probe. The bundled native `session-supervisor --probe` must succeed after being started in its own session/process group. The probe opens a pidfd for **itself** and uses signal **0** with `PIDFD_SIGNAL_PROCESS_GROUP`; it sends no signal to another process and cannot start a Shell command.
- **Permanent:** working `systemctl --user` and systemd user unit. **Temporary (future T06):** no systemd unit, foreground only. WSL2 does not wake a stopped distribution.
- Until T04 replaces checkout compilation with verified prebuilt artifacts, the development installer still builds the native helper locally and is **not** a clean-host one-command distribution.

Verified development smoke: WSL2 Linux 6.18.33.2, x86_64, glibc 2.39, Node 24.21.0; built native helper `--probe` exit 0. Negative unit coverage includes kernel < 6.9, WSL1, absent/old libc, wrong architecture and capability-probe failure. **ARM64 clean-host/native ABI acceptance and immutable GitHub Release verification remain untested**; neither architecture is advertised as a published asset.
