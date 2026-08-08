import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Secrets stay in this file's process, never in the browser bundle.
 *
 * The context.dev key is read here (Node side) and injected as a header by the dev
 * proxy. The client only ever calls the same-origin path `/api/context/*`, so a
 * `grep` of `dist/` turns up nothing. The ElevenLabs agent id is public by design —
 * a public agent needs no key to connect.
 */
function readWorkspaceEnv(): Record<string, string> {
  for (const candidate of ["../.env", ".env", "../../.env"]) {
    try {
      const raw = readFileSync(resolve(import.meta.dirname, candidate), "utf8");
      const out: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }
      if (Object.keys(out).length) return out;
    } catch {
      // try the next candidate
    }
  }
  return {};
}

export default defineConfig(() => {
  const env = { ...readWorkspaceEnv(), ...process.env };
  const contextKey = env.CONTEXT_DEV_API_KEY ?? "";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api/context": {
          target: "https://api.context.dev",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/context/, ""),
          configure: (proxy: any) => {
            proxy.on("proxyReq", (proxyReq: any) => {
              if (contextKey) proxyReq.setHeader("authorization", `Bearer ${contextKey}`);
            });
          },
        },
      },
    },
    define: {
      // Public identifiers only. Never a key.
      __AGENT_ID__: JSON.stringify(env.ELEVENLABS_AGENT_ID ?? ""),
    },
  };
});
