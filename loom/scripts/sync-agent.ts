/**
 * Push the tool contract and system prompt to the live ElevenLabs agent.
 *
 *   node --experimental-strip-types scripts/sync-agent.ts
 *
 * The agent's tools are generated from src/contract/tools.ts, never hand-typed into
 * the dashboard. Run this after changing a tool and the two can't disagree.
 *
 * Reads ELEVEN_LABS_API_KEY and ELEVENLABS_AGENT_ID from the workspace .env.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, toElevenLabsTool } from "../src/contract/tools.ts";
import { SYSTEM_PROMPT } from "../src/voice/agentConfig.ts";

const here = dirname(fileURLToPath(import.meta.url));
const API = "https://api.elevenlabs.io/v1";

function env(): Record<string, string> {
  for (const candidate of ["../../.env", "../.env"]) {
    try {
      const raw = readFileSync(resolve(here, candidate), "utf8");
      const out: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }
      if (out.ELEVEN_LABS_API_KEY) return out;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not find ELEVEN_LABS_API_KEY in the workspace .env");
}

const ENV = env();
const KEY = ENV.ELEVEN_LABS_API_KEY!;
const AGENT_ID = ENV.ELEVENLABS_AGENT_ID;
const AGENT_NAME = "Loom research canvas";

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "xi-api-key": KEY, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * The prompt comes from agentConfig.ts, NOT from agent-prompt.md.
 *
 * agent-prompt.md is a paste-able copy wrapped in explanatory markdown ("Paste this
 * into the dashboard..."). Syncing that file verbatim once shipped the wrapper as the
 * agent's instructions, and the agent duly behaved like a documentation reader —
 * it answered from memory and refused to look anything up. Read the real constant.
 */
function systemPrompt(): string {
  if (SYSTEM_PROMPT.trim().length < 200) throw new Error("SYSTEM_PROMPT looks empty");
  return SYSTEM_PROMPT.trim();
}

/**
 * Find the Loom agent, or make one.
 *
 * Tomorrow this runs against a brand-new key with an empty account, so requiring an
 * agent id to already exist would be a guaranteed morning blocker. Resolve in order:
 * the id in .env if it still resolves, an agent already named Loom on this account,
 * or a fresh one.
 */
async function resolveAgentId(): Promise<{ id: string; created: boolean }> {
  if (AGENT_ID) {
    try {
      await call(`/convai/agents/${AGENT_ID}`);
      return { id: AGENT_ID, created: false };
    } catch {
      console.log(`  ELEVENLABS_AGENT_ID does not resolve on this key — looking for another`);
    }
  }

  const agents: Array<{ agent_id: string; name?: string }> = (await call("/convai/agents")).agents ?? [];
  const existing = agents.find((a) => a.name === AGENT_NAME);
  if (existing) {
    console.log(`  found existing agent ${existing.agent_id}`);
    return { id: existing.agent_id, created: false };
  }

  const created = await call("/convai/agents/create", {
    method: "POST",
    body: JSON.stringify({
      name: AGENT_NAME,
      conversation_config: { agent: { prompt: { prompt: systemPrompt() }, language: "en" } },
    }),
  });
  console.log(`  created agent ${created.agent_id}`);
  return { id: created.agent_id, created: true };
}

async function main() {
  const { id: agentId, created } = await resolveAgentId();

  const existing: Array<{ id: string; tool_config?: { name?: string } }> =
    (await call("/convai/tools")).tools ?? [];
  const byName = new Map(existing.map((t) => [t.tool_config?.name, t.id]));

  const toolIds: string[] = [];

  for (const tool of Object.values(TOOLS)) {
    const declared = toElevenLabsTool(tool) as {
      name: string;
      description: string;
      expects_response?: boolean;
      parameters: unknown;
    };

    const tool_config = {
      type: "client",
      name: declared.name,
      description: declared.description,
      expects_response: declared.expects_response ?? false,
      response_timeout_secs: tool.name === "research" ? 120 : 30,
      parameters: declared.parameters,
    };

    const priorId = byName.get(declared.name);
    if (priorId) {
      await call(`/convai/tools/${priorId}`, { method: "PATCH", body: JSON.stringify({ tool_config }) });
      toolIds.push(priorId);
      console.log(`  updated  ${declared.name}`);
    } else {
      const created = await call("/convai/tools", { method: "POST", body: JSON.stringify({ tool_config }) });
      toolIds.push(created.id);
      console.log(`  created  ${declared.name}`);
    }
  }

  await call(`/convai/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: AGENT_NAME,
      conversation_config: {
        agent: {
          prompt: {
            prompt: systemPrompt(),
            // gemini-2.0-flash could not hold the tool contract: it looped on invalid
            // render_ui calls and repeated itself. Opus 4.8 is the most reliable
            // tool-caller ElevenLabs offers. It costs some per-turn latency, which is
            // partly why the dashboard now renders without waiting on a model decision.
            llm: "claude-opus-4-8",
            tool_ids: toolIds,
            temperature: 0.3,
          },
          first_message: "What should I look into?",
          language: "en",
        },
      },
      platform_settings: { auth: { enable_auth: false } },
    }),
  });

  // Rewrite the paste-able copy from the same constant we just pushed. It had
  // drifted to less than half the real prompt, and a stale prompt pasted into the
  // dashboard is an agent that misbehaves for reasons nobody can see in the code.
  writeFileSync(
    resolve(here, "../agent-prompt.md"),
    `<!-- GENERATED by scripts/sync-agent.ts from SYSTEM_PROMPT in src/voice/agentConfig.ts.
` +
      `     Do not edit by hand — edit the constant and re-run \`pnpm sync-agent\`.
` +
      `     This copy exists only for pasting into the ElevenLabs dashboard by hand. -->

` +
      `${systemPrompt()}\n`,
    "utf8",
  );

  console.log(`\nSynced ${toolIds.length} tools to ${agentId}`);
  console.log("Rewrote agent-prompt.md from SYSTEM_PROMPT");

  if (created || agentId !== AGENT_ID) {
    console.log(
      `\n  Add this line to the workspace .env, then restart the dev server:\n` +
        `\n    ELEVENLABS_AGENT_ID=${agentId}\n` +
        `\n  (the agent id is public — it is meant to ship in the browser bundle)`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
