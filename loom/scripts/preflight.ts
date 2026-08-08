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
      const attachedIds: string[] = prompt.tool_ids ?? [];
      const isPublic = agent.platform_settings?.auth?.enable_auth === false;

      // Names, not a count.
      //
      // This check compared lengths, and passed cleanly while the agent carried a
      // retired `research` tool and none of the four that replaced it — the numbers
      // happened to match. The first symptom was a failed tool call mid-conversation.
      const allTools = (await (await fetch(`${EL}/convai/tools`, { headers: { "xi-api-key": elKey } })).json()) as any;
      const nameById = new Map<string, string>(
        (allTools.tools ?? []).map((t: any) => [t.id, t.tool_config?.name]).filter(([, n]: [string, string]) => !!n),
      );
      const attached = attachedIds.map((id) => nameById.get(id)).filter((n): n is string => !!n);
      const expectedNames = Object.keys(TOOLS);
      const missing = expectedNames.filter((n) => !attached.includes(n));
      const extra = attached.filter((n) => !expectedNames.includes(n));

      add(missing.length === 0 && extra.length === 0 ? "pass" : "fail", "Agent tools",
        missing.length === 0 && extra.length === 0
          ? `${attached.length} attached, matching the contract`
          : `${[
              missing.length ? `missing ${missing.join(", ")}` : "",
              extra.length ? `unexpected ${extra.join(", ")}` : "",
            ].filter(Boolean).join("; ")}`,
        missing.length === 0 && extra.length === 0 ? undefined : "Run `pnpm sync-agent`");
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

    // Search is the other call every topic research makes, and it is cheap. Between
    // this and the scrape above, a green preflight means the whole basic path works.
    const t1 = Date.now();
    const search = await fetch(`${CTX}/web/search`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: "example pricing comparison", numResults: 10, markdownOptions: { enabled: false } }),
    });
    const searchMs = Date.now() - t1;
    const searchBody = await search.text();

    if (search.ok) {
      const count = (searchBody.match(/"url"\s*:/g) ?? []).length;
      add("pass", "context.dev search", `${search.status} in ${searchMs}ms, ${count} results`);
    } else if (/USAGE_EXCEEDED|depleted/i.test(searchBody)) {
      add("fail", "context.dev search", "credits exhausted", "Top up or use a new key — research cannot find sources without this");
    } else {
      add("fail", "context.dev search", `${search.status}: ${searchBody.slice(0, 120)}`);
    }

    const credits = searchBody.match(/"credits_remaining":\s*(\d+)/)?.[1];
    if (credits) {
      add(Number(credits) > 500 ? "pass" : "warn", "context.dev credits", `${credits} remaining`);
    }
  }

  // --- The costlier raw capabilities, only on request ---------------------
  //
  // Crawl bills per page and images can return hundreds of entries, so neither runs
  // in the basic check. `--deep` exercises them before a demo, and prints what each
  // one actually consumed so the spend is visible rather than inferred.
  if (ctxKey && process.argv.includes("--deep")) {
    const auth = { Authorization: `Bearer ${ctxKey}` };

    const crawlStart = Date.now();
    try {
      const crawl = await fetch(`${CTX}/web/crawl`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", limit: 2 }),
      });
      const body = await crawl.text();
      const pages = (body.match(/"markdown"\s*:/g) ?? []).length;
      const consumed = body.match(/"credits_consumed":\s*(\d+)/)?.[1] ?? "?";
      add(
        crawl.ok ? "pass" : "fail",
        "context.dev crawl",
        `${crawl.status} in ${Date.now() - crawlStart}ms, ${pages} page(s), ${consumed} credits`,
        crawl.ok ? undefined : body.slice(0, 120),
      );
    } catch (err) {
      add("fail", "context.dev crawl", String(err).slice(0, 100));
    }

    const imgStart = Date.now();
    try {
      const images = await fetch(`${CTX}/web/scrape/images?url=${encodeURIComponent("https://example.com")}`, {
        headers: auth,
      });
      const body = await images.text();
      const count = (body.match(/"src"\s*:/g) ?? []).length;
      const consumed = body.match(/"credits_consumed":\s*(\d+)/)?.[1] ?? "?";
      add(
        images.ok ? "pass" : "fail",
        "context.dev images",
        `${images.status} in ${Date.now() - imgStart}ms, ${count} image(s), ${consumed} credits`,
        images.ok ? undefined : body.slice(0, 120),
      );
    } catch (err) {
      add("fail", "context.dev images", String(err).slice(0, 100));
    }

    // Markdown latency is the number the retrieval timeout rests on now that the
    // 22s extract path is gone.
    const samples = [
      "https://stripe.com/pricing",
      "https://vercel.com/pricing",
      "https://www.notion.com/pricing",
    ];
    const times: number[] = [];
    for (const url of samples) {
      const started = Date.now();
      try {
        const res = await fetch(`${CTX}/web/scrape/markdown?url=${encodeURIComponent(url)}`, { headers: auth });
        const ms = Date.now() - started;
        if (res.ok) times.push(ms);
        console.log(`      ${res.ok ? "ok  " : "fail"} ${String(ms).padStart(6)}ms  ${url}`);
      } catch (err) {
        console.log(`      ERR  ${String(Date.now() - started).padStart(6)}ms  ${url} — ${String(err).slice(0, 60)}`);
      }
    }

    if (times.length) {
      const BUDGET_MS = 25_000;
      const max = Math.max(...times);
      const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
      add(
        max < BUDGET_MS * 0.5 ? "pass" : max < BUDGET_MS ? "warn" : "fail",
        "Markdown latency",
        `median ${median}ms, slowest ${max}ms against a ${BUDGET_MS}ms budget`,
        max < BUDGET_MS * 0.5 ? undefined : "Raise DEFAULT_TIMEOUT_MS in src/research/context.ts",
      );
    } else {
      add("fail", "Markdown latency", "no sample completed", "Scraping is not working at all");
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
        (process.argv.includes("--deep") ? "" : "Run `pnpm preflight --deep` to exercise crawl, images and markdown latency too.\n"),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("preflight itself failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
