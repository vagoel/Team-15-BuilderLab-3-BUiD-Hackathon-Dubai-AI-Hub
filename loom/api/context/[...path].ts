/**
 * Production stand-in for the Vite dev proxy in vite.config.ts.
 *
 * The browser only ever calls the same-origin path `/api/context/*`; this function
 * attaches the context.dev key on the server side and forwards the call. The key is
 * never part of the client bundle, in dev or in production — the two environments
 * differ only in which piece of server code holds it.
 *
 * Only the path is taken from the request. The origin is fixed below, so a crafted
 * path cannot redirect an authenticated request at some other host.
 */

const UPSTREAM = "https://api.context.dev";

/** Long enough for /web/extract, which is measured at ~22s per URL. */
export const config = { maxDuration: 60 };

export default async function handler(request: Request): Promise<Response> {
  const key = process.env.CONTEXT_DEV_API_KEY;
  if (!key) {
    return json(500, { error: "CONTEXT_DEV_API_KEY is not set on this deployment." });
  }

  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/api\/context/, "");
  const target = `${UPSTREAM}${path}${incoming.search}`;

  const headers = new Headers();
  headers.set("authorization", `Bearer ${key}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      // GET/HEAD must not carry one, and forwarding the stream needs duplex support
      // that not every runtime exposes — buffering keeps this portable.
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });

    // Pass the upstream status and body through untouched: research/context.ts reads
    // status codes (401 = out of credits, 404 = dead page) to decide whether a retry
    // is worth attempting, and rewriting them here would break that.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json(502, { error: `Upstream request failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
