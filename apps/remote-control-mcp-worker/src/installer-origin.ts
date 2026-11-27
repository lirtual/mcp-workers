// Never trust request Host alone: the allowed origin is supplied by the
// deployment's validated Custom Domain binding, not a source-code hostname.
export function validInstallerOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 255) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !!u.hostname && !u.port &&
      !u.username && !u.password && !u.search && !u.hash &&
      u.pathname === "/" && u.origin === value;
  } catch { return false; }
}
