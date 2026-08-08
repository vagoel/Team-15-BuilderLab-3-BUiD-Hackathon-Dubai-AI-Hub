/**
 * One command that says whether the app will work right now.
 *
 *   pnpm preflight
 *
 * Every check here exists because it failed at least once while building this. Run it
 * the moment a new key lands: it takes about thirty seconds and it is the difference
 * between finding out at the desk and finding out on stage.
 *
 * Exits non-zero if anything blocking is wrong.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/contract/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EL = "https://api.elevenlabs.io/v1";
const CTX = "https://api.context.dev/v1";

type Level = "pass" | "warn" | "fail";
const results: Array<{ level: Level; label: string; detail: string; fix?: string }> = [];

const add = (level: Level, label: string, detail: string, fix?: string) =>
  results.push({ level, label, detail, ...(fix ? { fix } : {}) });

function env(): Record<string, string> {
  for (const candidate of ["../../.env", "../.env"]) {
    try {
      const raw = readFileSync(resolve(here, candidate), "utf8");
      const out: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }
      if (Object.keys(out).length) return out;
    } catch {
      /* try next */
    }
  }
  return {};
}

async function main() {
  const ENV = { ...env(), ...process.env };
  const elKey = ENV.ELEVEN_LABS_API_KEY;
  const ctxKey = ENV.CONTEXT_DEV_API_KEY;
  const agentId = ENV.ELEVENLABS_AGENT_ID;

  // --- ElevenLabs ---------------------------------------------------------
  if (!elKey) {
    add("fail", "ElevenLabs key", "ELEVEN_LABS_API_KEY missing", "Add it to the workspace .env");
  } else {
    const res = await fetch(`${EL}/user/subscription`, { headers: { "xi-api-key": elKey } });
    if (!res.ok) {
      add("fail", "ElevenLabs key", `rejected (${res.status})`, "Check the key is pasted whole");
    } else {
      const sub = (await res.json()) as { character_count?: number; character_limit?: number; tier?: string };
      const used = sub.character_count ?? 0;
      const limit = sub.character_limit ?? 0;
      const left = limit - used;
      const pct = limit ? Math.round((left / limit) * 100) : 0;

      if (left <= 0) {
        add("fail", "ElevenLabs quota", `0 of ${limit} characters left (tier: ${sub.tier})`,
          "The agent cannot speak. Upgrade the plan or use a different key.");
      } else if (pct < 15) {
        add("warn", "ElevenLabs quota", `${left} of ${limit} characters left — about ${pct}%`,
          "Enough for a short demo only. A failing tool call makes the agent apologise aloud, which spends this fast.");
      } else {
        add("pass", "ElevenLabs quota", `${left} of ${limit} characters left (tier: ${sub.tier})`);
      }

      // A voice the key may not actually be allowed to use is a silent stage failure.
      const voices = await fetch(`${EL}/voices`, { headers: { "xi-api-key": elKey } });
      if (voices.ok) {
        const list = (await voices.json()) as { voices?: Array<{ category?: string }> };
        const premade = (list.voices ?? []).filter((v) => v.category === "premade").length;
        add(premade > 0 ? "pass" : "warn", "ElevenLabs voices", `${premade} premade voices available`);
      }
    }
  }

  // --- The agent itself ---------------------------------------------------
  if (elKey && agentId) {
    const res = await fetch(`${EL}/convai/agents/${agentId}`, { headers: { "xi-api-key": elKey } });
    if (!res.ok) {
      add("fail", "Agent", `${agentId} does not resolve (${res.status})`,
        "Run `pnpm sync-agent` — it will create one and print the .env line");
    } else {
      const agent = (await res.json()) as any;
      const prompt = agent.conversation_config?.agent?.prompt ?? {};
      const toolCount = (prompt.tool_ids ?? []).length;
      const expected = Object.keys(TOOLS).length;
      const isPublic = agent.platform_settings?.auth?.enable_auth === false;

      add(toolCount === expected ? "pass" : "fail", "Agent tools",
        `${toolCount} attached, ${expected} in the contract`,
        toolCount === expected ? undefined : "Run `pnpm sync-agent`");
      add(isPublic ? "pass" : "fail", "Agent auth",
        isPublic ? "public — the browser can connect with no key" : "requires auth",
        isPublic ? undefined : "Run `pnpm sync-agent`");
      add(prompt.prompt?.length > 1000 ? "pass" : "fail", "Agent prompt",
        `${prompt.prompt?.length ?? 0} characters, llm: ${prompt.llm}`,
        prompt.prompt?.length > 1000 ? undefined : "Run `pnpm sync-agent`");
    }
  } else if (elKey && !agentId) {
    add("fail", "Agent", "ELEVENLABS_AGENT_ID missing from .env",
      "Run `pnpm sync-agent` — it creates one and prints the line to add");
  }

  // --- context.dev --------------------------------------------------------
  if (!ctxKey) {
    add("fail", "context.dev key", "CONTEXT_DEV_API_KEY missing", "Add it to the workspace .env");
  } else {
    const auth = { Authorization: `Bearer ${ctxKey}` };
    const t0 = Date.now();
    const scrape = await fetch(`${CTX}/web/scrape/markdown?url=${encodeURIComponent("https://example.com")}`, { headers: auth });
    const scrapeMs = Date.now() - t0;
    add(scrape.ok ? "pass" : "fail", "context.dev scrape", `${scrape.status} in ${scrapeMs}ms`,
      scrape.ok ? undefined : "Scraping is the cheap call — if this fails the key is wrong or dead");

    // Extraction is the expensive one, and the one that ran out of credit last time.
    const t1 = Date.now();
    const extract = await fetch(`${CTX}/web/extract`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com",
        schema: {
          type: "object",
          properties: { records: { type: "array", items: { type: "object", properties: { title: { type: "string" } } } } },
          required: ["records"],
        },
      }),
    });
    const extractMs = Date.now() - t1;
    const body = await extract.text();

    if (extract.ok) {
      add("pass", "context.dev extract", `${extract.status} in ${extractMs}ms`);
      const credits = body.match(/"credits_remaining":\s*(\d+)/)?.[1];
      if (credits) add(Number(credits) > 500 ? "pass" : "warn", "context.dev credits", `${credits} remaining`);
    } else if (/USAGE_EXCEEDED|depleted/i.test(body)) {
      add("fail", "context.dev extract", "credits exhausted",
        "Live research will silently fall back to heuristic parsing. Top up or use a new key.");
    } else {
      add("fail", "context.dev extract", `${extract.status}: ${body.slice(0, 120)}`);
    }
  }

  // --- Extraction latency, the number the whole timeout budget rests on -----
  //
  // The 45s abort budget was set from a single ~22s measurement. If the real tail is
  // fatter than that one sample, some fraction of live calls abort and silently
  // degrade to heuristic parsing — convincing wrong answers rather than an error.
  // `pnpm preflight --deep` measures it properly before anyone is on stage.
  if (ctxKey && process.argv.includes("--deep")) {
    const EXTRACT_BUDGET_MS = 45_000;
    const samples = [
      "https://stripe.com/pricing",
      "https://vercel.com/pricing",
      "https://www.notion.com/pricing",
      "https://openai.com/api/pricing/",
      "https://railway.com/pricing",
    ];
    const times: number[] = [];

    for (const url of samples) {
      const started = Date.now();
      try {
        const res = await fetch(`${CTX}/web/extract`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctxKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            url,
            schema: {
              type: "object",
              properties: {
                records: { type: "array", items: { type: "object", properties: { plan: { type: "string" } } } },
              },
              required: ["records"],
            },
          }),
        });
        const ms = Date.now() - started;
        if (res.ok) times.push(ms);
        console.log(`      ${res.ok ? "ok  " : "fail"} ${String(ms).padStart(6)}ms  ${url}`);
      } catch (err) {
        console.log(`      ERR  ${String(Date.now() - started).padStart(6)}ms  ${url} — ${String(err).slice(0, 60)}`);
      }
    }

    if (times.length) {
      const max = Math.max(...times);
      const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
      const headroom = Math.round((EXTRACT_BUDGET_MS / max) * 10) / 10;
      add(
        max < EXTRACT_BUDGET_MS * 0.6 ? "pass" : max < EXTRACT_BUDGET_MS ? "warn" : "fail",
        "Extraction latency",
        `median ${median}ms, slowest ${max}ms against a ${EXTRACT_BUDGET_MS}ms budget (${headroom}x headroom)`,
        max < EXTRACT_BUDGET_MS * 0.6
          ? undefined
          : "Raise EXTRACT_TIMEOUT_MS in src/research/context.ts — an abort silently falls back to heuristic parsing",
      );
    } else {
      add("fail", "Extraction latency", "no sample completed", "Extraction is not working at all");
    }
  }

  // --- Report -------------------------------------------------------------
  const icon = { pass: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  console.log(`\nLoom preflight${process.argv.includes("--deep") ? " (deep)" : ""}\n`);
  for (const r of results) {
    console.log(`[${icon[r.level]}] ${r.label.padEnd(22)} ${r.detail}`);
    if (r.fix) console.log(`${" ".repeat(11)}→ ${r.fix}`);
  }

  const failed = results.filter((r) => r.level === "fail").length;
  const warned = results.filter((r) => r.level === "warn").length;
  console.log(
    failed
      ? `\n${failed} blocking problem${failed === 1 ? "" : "s"}. Fix those before demoing.\n`
      : `\nReady${warned ? ` — with ${warned} thing${warned === 1 ? "" : "s"} to keep an eye on` : ""}.\n` +
        (process.argv.includes("--deep") ? "" : "Run `pnpm preflight --deep` to measure real extraction latency too.\n"),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("preflight itself failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
