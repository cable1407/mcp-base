type Handler = (req: Request) => Promise<Response>;

export interface AccessLogConfig {
  enabled: boolean;
  log?: (line: string) => void;
}

const UA_MAX = 200;

export function withAccessLog(config: AccessLogConfig, inner: Handler): Handler {
  if (!config.enabled) return inner;
  const log = config.log ?? ((line: string) => console.log(line));
  return async (req: Request): Promise<Response> => {
    const start = performance.now();
    const url = new URL(req.url);
    const res = await inner(req);
    const elapsed = Math.round(performance.now() - start);
    const ip = clientIp(req);
    const ua = truncateUa(req.headers.get("user-agent"));
    log(`[http] ${ip} ${req.method} ${url.pathname} ${res.status} ${elapsed}ms ua="${ua}"`);
    return res;
  };
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff === null || xff.trim() === "") return "-";
  const first = xff.split(",")[0]?.trim() ?? "";
  return first === "" ? "-" : first;
}

function truncateUa(raw: string | null): string {
  if (raw === null || raw === "") return "-";
  return raw.length <= UA_MAX ? raw : raw.slice(0, UA_MAX);
}
