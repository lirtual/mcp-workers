/** Non-sensitive, bounded runtime facts; not a grant of remote permissions. */
export type DeviceInfo = {
  hostname: string;
  os: "linux" | "windows" | "darwin";
  os_version: string;
  arch: string;
  environment: "native" | "wsl2" | "container";
  agent_version?: string;
  /** Future native updater readiness, never inferred from a version or pairing. */
  upgrade_protocol?: "owner-one-shot-v1";
};

export function parseDeviceInfo(raw: string): DeviceInfo | null {
  if (raw.length > 1200) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const allowed = new Set(["kind", "hostname", "os", "os_version", "arch",
    "environment", "agent_version", "capabilities", "upgrade_protocol"]);
  if (v.kind !== "device_info" || Object.keys(v).some(k => !allowed.has(k))) return null;
  const label = (x: unknown, max: number) =>
    typeof x === "string" && x.length > 0 && x.length <= max &&
    !/[\x00-\x1f\x7f]/.test(x);
  if (!label(v.hostname, 64) || !label(v.os_version, 96) ||
      !label(v.arch, 16) ||
      (v.agent_version !== undefined && !label(v.agent_version, 48)) ||
      (v.upgrade_protocol !== undefined &&
        (v.upgrade_protocol !== "owner-one-shot-v1" || v.os !== "windows" ||
         v.arch !== "x64" || v.environment !== "native")) ||
      !["linux", "windows", "darwin"].includes(String(v.os)) ||
      !["native", "wsl2", "container"].includes(String(v.environment)) ||
      // Deployed Agents still report this legacy field. Validate and discard it.
      (v.capabilities !== undefined &&
        (!Array.isArray(v.capabilities) || v.capabilities.length < 1 ||
         v.capabilities.length > 3 || !v.capabilities.includes("read") ||
         new Set(v.capabilities).size !== v.capabilities.length ||
         v.capabilities.some(c => !["read", "file_write", "shell"].includes(c))))) return null;
  return {
    hostname: v.hostname as string,
    os: v.os as DeviceInfo["os"],
    os_version: v.os_version as string,
    arch: v.arch as string,
    environment: v.environment as DeviceInfo["environment"],
    ...(v.agent_version !== undefined ? { agent_version: v.agent_version as string } : {}),
    ...(v.upgrade_protocol === "owner-one-shot-v1" ? { upgrade_protocol: v.upgrade_protocol } : {}),
  };
}
