function decodeRepeated(value: string): string {
  let current = value;
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      throw new Error("INVALID_ARGUMENT: path contains invalid percent encoding");
    }
  }
  return current;
}

export function normalizeOpenListPath(input: string): string {
  const decoded = decodeRepeated(input.trim());
  if (!decoded.startsWith("/")) throw new Error("INVALID_ARGUMENT: path must be absolute");

  const parts: string[] = [];
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("PATH_FORBIDDEN: parent traversal is not allowed");
    parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

export function isPathAllowed(path: string, allowedRoots: string[]): boolean {
  const normalized = normalizeOpenListPath(path);
  return allowedRoots.some((root) => {
    const allowed = normalizeOpenListPath(root);
    return allowed === "/" || normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

export function assertPathAllowed(path: string, allowedRoots: string[]): string {
  const normalized = normalizeOpenListPath(path);
  if (!isPathAllowed(normalized, allowedRoots)) throw new Error("PATH_FORBIDDEN: path is outside OPENLIST_ALLOWED_PATHS");
  return normalized;
}

export function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("INVALID_ARGUMENT: name must be a single file or directory name");
  }
  return trimmed;
}
