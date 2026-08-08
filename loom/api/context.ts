import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Production stand-in for the Vite dev proxy in vite.config.ts.
 *
 * The browser only ever calls the same-origin path `/api/context/*`; this function
 * attaches the context.dev key server-side and forwards the call. The key is never
 * part of the client bundle in either environment — dev and production differ only
 * in which piece of server code holds it.
 *
 * One flat function rather than `api/context/[...path].ts`: outside Next.js, Vercel's
 * router reads `[...path]` as a single dynamic segment, so `/api/context/v1/web/search`
 * 404s while `/api/context/ping` resolves. The rewrite in vercel.json hands the whole
 * remaining path over in `__path` instead, which has no depth limit.
 *
 * Only the path travels; the origin is fixed below, so a crafted path cannot point an
 * authenticated request at another host.
 */

const UPSTREAM = "https://api.context.dev";

/** The forwarded path, injected by the vercel.json rewrite. */
const PATH_PARAM = "__path";

/** Long enough for /web/extract, measured at ~22s per URL. */
export const config = { maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = process.env.CONTEXT_DEV_API_KEY;
  if (!key) {
    send(res, 500, { error: "CONTEXT_DEV_API_KEY is not set on this deployment." });
    return;
  }

  // `req.url` is a path, not an absolute URL, so parsing needs a base. The base is a
  // placeholder for the parser and never reaches the network.
  const incoming = new URL(req.url ?? "/", "http://proxy.invalid");
  const forwarded = incoming.searchParams.get(PATH_PARAM) ?? "";
  incoming.searchParams.delete(PATH_PARAM);

  const path = `/${forwarded.replace(/^\/+/, "")}`;
  const query = incoming.searchParams.toString();
  const target = `${UPSTREAM}${path}${query ? `?${query}` : ""}`;

  const method = req.method ?? "GET";
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") headers["content-type"] = contentType;

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await readBody(req),
    });

    // Status and body pass through untouched: research/context.ts reads status codes
    // (401 = out of credits, 404 = dead page) to decide whether a retry is worthwhile,
    // and rewriting them here would break that.
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(text);
  } catch (err) {
    send(res, 502, { error: `Upstream request failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
