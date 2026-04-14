export function normalizeBasePath(raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw === "/") return "";
  if (raw.includes("?") || raw.includes("#")) {
    throw new Error("CORTEX_BASE_PATH must not contain a query (?) or fragment (#)");
  }
  if (raw.includes("..")) {
    throw new Error("CORTEX_BASE_PATH must not contain '..'");
  }
  let p = raw.startsWith("/") ? raw : `/${raw}`;
  p = p.replace(/\/+/g, "/");
  if (p !== "/" && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/") return "";
  return p;
}

export function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}
