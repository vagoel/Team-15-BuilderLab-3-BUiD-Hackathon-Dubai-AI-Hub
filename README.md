# Scry

**Voice-driven web research that builds a dashboard while you talk.**

- **Live app:** https://loom-beryl-theta.vercel.app/
- **Pitch deck:** https://loom-beryl-theta.vercel.app/deck.html
- **Demo video:** https://www.loom.com/share/48817936b04848a0b0207c6c9a5089b9

Scry is a single-page React app with a conversational agent attached to it. You ask a
research question out loud — or type it — and the agent searches the live web, reads
the pages it picked, and a dashboard assembles itself on screen: stat cards, a chart,
a sortable table, findings, and the list of sources it read. Then you keep talking to
the dashboard: *"sort by price, cheapest first"*, *"highlight anything under fifty"*,
*"make the chart bigger"*, *"switch to focus"*, *"export this as a PDF"*.

Two things make it different from a chat window that happens to speak:

- **The rows never pass through the language model.** Research results land in a
  Zustand store in the browser. The agent gets back a dataset id, a headline and a
  handful of counts — a couple of hundred tokens — and the canvas reads the actual
  rows out of the store itself. A 487-row table costs the same per turn as a 4-row
  one.
- **The agent cannot invent a source.** It never passes a URL to a retrieval tool. It
  calls `search_web` (or registers URLs the user said out loud with
  `use_direct_urls`), gets back an opaque source-set id plus numbered candidates, and
  retrieves by *index*. A URL the model composed has nowhere to enter the system.

Rows come from one place only: a real table that a page actually printed, parsed
deterministically out of scraped markdown. A prose page yields **zero rows**, the tool
says so plainly, and the agent's instructions tell it to read a source and add cited
findings instead of describing numbers it did not read.

The app lives in [`loom/`](loom/). The directory name is historical — the product was
renamed from Loom to Scry, the folder was not.

---

## What is actually implemented

- A voice session over WebRTC, plus a text-only WebSocket session that starts
  automatically the first time you press Send without a mic (`loom/src/voice/useVoiceSession.ts`).
- **24 client tools**, all executing in the browser, defined once in
  `loom/src/contract/tools.ts` and bound to handlers in `loom/src/voice/toolHandlers.ts`:
  - *Research* — `search_web`, `use_direct_urls`, `collect_sources`,
    `set_research_findings`, `deepen`, `read_source`
  - *Canvas* — `render_ui`, `add_component`, `remove_component`, `move_component`,
    `update_component`, `resize_component`, `set_layout`, `focus_component`,
    `scroll_component`, `scroll_page`, `undo`, `clear_canvas`, `get_ui_state`
  - *Data* — `set_filter`, `sort_table`, `highlight_rows`, `export_data` (CSV),
    `export_report` (print-ready preview → browser Print / Save as PDF)
- **Six component types**, and no more: `stat_cards`, `chart` (hand-rolled SVG bar /
  line / pie), `comparison_table` (TanStack table + virtualiser, click-to-sort shared
  with the voice tool), `findings`, `source_list`, `image_gallery`.
- **Three layout presets** — `grid` (12-column, the default), `masonry`, `focus` —
  switchable by voice or by clicking the switcher. Cards are draggable and resizable
  via `react-grid-layout`, and the drag handle and `resize_component` write the same
  state.
- **Report templates**: save the report on screen as a reusable, data-free recipe
  (`loom/src/templates/`). Capture strips dataset ids, field keys, filters and titles,
  so a layout saved from a pricing comparison can be applied to a restaurant report.
  Templates persist in `localStorage`; the selected one is frozen for the duration of
  a voice session so the agent's instructions and the renderer cannot drift apart.
- **A 30-minute warm cache** for scrape/crawl/image calls, in memory and mirrored into
  `sessionStorage` (`loom/src/research/cache.ts`).
- Light/dark/system theming, self-hosted fonts, no CDN requests.

What is **not** here, deliberately: no backend of our own, no database, no accounts, no
background jobs, no polling, no live re-fetch when a page changes mid-conversation.
Everything is request-time, in one browser tab. `SERVER_TOOLS` in the contract is empty
— every tool is a client tool.

---

## Architecture

```
  you ──speech/text──►  ElevenLabs agent  (their infra: ASR, TTS, turn-taking,
                             │             tool selection, the reasoning model)
                             │
                             │  client tool call  (name + JSON args over the session)
                             ▼
  ┌──────────────────────── browser tab ─────────────────────────────────────┐
  │                                                                          │
  │  toolHandlers.ts ──► zod validation (same schemas that declared the tool) │
  │        │                                                                  │
  │        ├─ research tools ─► research/  ─► fetch("/api/context/v1/…")      │
  │        │                                        │  same origin, no key    │
  │        │                                        │                         │
  │        ├─ canvas/data tools ─────┐               │                        │
  │        │                         ▼               │                        │
  │        │                  Zustand store (store.ts) ◄── datasets, rows      │
  │        │                         │                                        │
  │        └─ get_ui_state ◄─────────┤                                        │
  │                                  ▼                                        │
  │                          Canvas.tsx + registry.tsx  (React renders rows)   │
  │                                                                            │
  └────────────────────────────────┬───────────────────────────────────────────┘
                                   │
              dev:  Vite proxy (vite.config.ts)      prod: Vercel function
              adds `Authorization: Bearer …`         (loom/api/context.ts)
                                   │                          │
                                   └────────────┬─────────────┘
                                                ▼
                                    https://api.context.dev
                          /v1/web/search · /v1/web/scrape/markdown
                          /v1/web/crawl  · /v1/web/scrape/images
                                    /v1/brand/retrieve
```

**Which side holds which key.**

| Secret | Where it lives | Ever in the browser bundle? |
|---|---|---|
| `CONTEXT_DEV_API_KEY` | Node side only — the Vite dev proxy in `loom/vite.config.ts`, or `process.env` inside `loom/api/context.ts` on Vercel | **No.** The client only ever fetches the same-origin path `/api/context/*`. |
| `ELEVEN_LABS_API_KEY` | Node side only — read by `loom/scripts/sync-agent.ts` and `loom/scripts/preflight.ts` | **No.** The running app never uses it. |
| `ELEVENLABS_AGENT_ID` | Injected at build time as the `__AGENT_ID__` define in `loom/vite.config.ts` | **Yes, on purpose.** The agent is configured as public (`enable_auth: false`), so a browser needs no credential to connect to it. |

The agent's prompt, tool declarations, reasoning model, temperature and first message
are not hand-typed into the ElevenLabs dashboard — they are generated from
`loom/src/contract/tools.ts` and `loom/src/voice/agentConfig.ts` and pushed by
`pnpm sync-agent`. Voice selection and other TTS settings are configured in the
ElevenLabs dashboard; they are not in this repo.

---

## Getting it running

### Prerequisites

- **Node.js** — Vite 6 and Vitest 3 require `^18 || ^20 || >=22`. Verified on Node
  24.15.0.
- **pnpm 9.15.9.** `loom/package.json` pins it via `packageManager`, so the easiest
  route is `corepack enable` and let Corepack fetch the right version. Otherwise
  `npm install -g pnpm@9.15.9`.
- A Chromium-based browser (Chrome or Edge) for the microphone. Safari works too.
  The mic needs a secure context — use `http://localhost:5173`, not a LAN IP.
- An **ElevenLabs** account with an API key and remaining agent character quota.
- A **context.dev** account with an API key and credits.

### 1. Install

```bash
git clone <this repo>
cd Team-15-BuilderLab-3-BUiD-Hackathon-Dubai-AI-Hub/loom
pnpm install
```

### 2. Create the `.env`

It goes at the **repository root**, one level above `loom/` — that is the first path
`loom/vite.config.ts` looks for (`../.env`, then `.env`, then `../../.env`), and the
one both scripts in `loom/scripts/` read. It is gitignored.

```dotenv
CONTEXT_DEV_API_KEY=
ELEVEN_LABS_API_KEY=
ELEVENLABS_AGENT_ID=
```

- `CONTEXT_DEV_API_KEY` — required to run the app. Read on the Node side and attached
  as an `Authorization` header by the proxy.
- `ELEVEN_LABS_API_KEY` — required only for `pnpm sync-agent` and `pnpm preflight`.
- `ELEVENLABS_AGENT_ID` — required to start a voice session. You do not have to know
  it up front; step 3 prints it.

Environment variables from the real environment win over the file
(`{ ...readWorkspaceEnv(), ...process.env }`), so you can override any of them
inline.

### 3. Create / sync the ElevenLabs agent

```bash
pnpm sync-agent
```

This resolves an agent (the id in `.env` if it still exists on this key, otherwise one
named "Loom research canvas" on the account, otherwise it creates one), then for every
entry in the tool contract it creates or PATCHes the matching ElevenLabs tool,
**detaches anything the contract no longer declares**, and attaches the resulting set
to the agent along with the system prompt, `temperature: 0.3`, the first message, and
`enable_auth: false`. It reads the agent back afterwards and throws if the attached
tools do not match the contract exactly. It also regenerates `loom/agent-prompt.md`
(a paste-able copy of the prompt — generated, never hand-edited; a test fails if it
drifts).

Put the printed agent id in the root `.env` as `ELEVENLABS_AGENT_ID` and restart the
dev server whenever it changes — it is baked in at build time.

### 4. Check everything before you rely on it

```bash
pnpm preflight          # ~30s, makes live vendor calls and spends a little quota
pnpm preflight --deep   # also exercises crawl, images, and markdown latency
```

Checks the ElevenLabs key and remaining characters, that the agent resolves, that its
attached tool *names* match the contract, that it is public, that the prompt is not
truncated, and that context.dev's scrape and search endpoints answer — reporting
remaining credits. Exits non-zero on anything blocking.

### 5. Run

```bash
pnpm dev            # http://localhost:5173
```

Press **Start** in the left rail and allow microphone access, or just type a question
and press Send — that opens a text-only session with no mic prompt at all.

### Tests, typecheck, build

```bash
pnpm test        # vitest run — 18 test files, 188 tests
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc --noEmit && vite build
pnpm verify      # all three
pnpm preview     # serve the production build locally
```

The suite runs entirely offline: context.dev is stubbed at the `fetch` boundary, so
no test spends credits. Coverage is concentrated where the risk is — the tool layer
(`voice/toolHandlers.test.ts`), the generated ElevenLabs schemas
(`contract/contract.test.ts`), markdown table parsing, the research pipeline, the
filter logic, and an end-to-end integration test that drives tool handlers against a
faked API.

---

## Production deployment

Deployed at **https://loom-beryl-theta.vercel.app/** on Vercel with **`loom/` as the
project root**, so `loom/vercel.json` is the config that applies:

```json
{
  "framework": "vite",
  "buildCommand": "pnpm build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/api/context/:path*", "destination": "/api/context?__path=:path*" }]
}
```

`loom/api/context.ts` is the production stand-in for the Vite dev proxy: it reads
`CONTEXT_DEV_API_KEY` from `process.env`, forwards the request to a hard-coded
`https://api.context.dev` origin, and passes the upstream status and body through
untouched (the client reads status codes to decide whether a retry is worth it). Its
`maxDuration` is 60 seconds.

The rewrite exists because outside Next.js, Vercel's router treats `[...path]` as a
*single* dynamic segment — `/api/context/ping` resolves but `/api/context/v1/web/search`
404s. Handing the whole remaining path over in a `__path` query parameter has no depth
limit. (`loom/api/context/[...path].ts` is the earlier attempt and is superseded by
the flat function; the rewrite never routes to it.)

Two environment variables must be set on the Vercel project:

- `CONTEXT_DEV_API_KEY` — runtime, read by the function.
- `ELEVENLABS_AGENT_ID` — **build time**, because `vite.config.ts` bakes it into the
  bundle as `__AGENT_ID__`.

---

## Repository layout

```
.env                      # gitignored; read by loom/vite.config.ts and loom/scripts/*
README.md                 # this file
TECH-SPEC.md              # one-page technical spec
loom/
  api/context.ts          # production serverless proxy to context.dev
  vercel.json             # framework, build, and the /api/context catch-all rewrite
  vite.config.ts          # dev proxy (holds the key), __AGENT_ID__ define
  scripts/
    sync-agent.ts         # push prompt + tools to the live ElevenLabs agent
    preflight.ts          # is this going to work right now?
  src/
    contract/             # zod: tools, UI spec, dataset, artifacts, templates
    research/             # context.dev client, source sets, pipeline, markdown tables, cache
    voice/                # ElevenLabs session, tool handlers, agent config + system prompt
    canvas/               # Canvas, autoLayout, templateLayout, six components
    templates/            # capture / storage / store for reusable report recipes
    report/               # print-ready report model + preview modal
    store.ts              # the Zustand store — the single source of truth
  PLAN.md, PRODUCT.md, DESIGN.md, BUILDING.md   # build-time notes (some predate the
                                                # current pipeline; the code wins)
```

---

## Known limits

- **Rows only exist where a page printed a table.** By design. Ask something whose
  answer lives in prose and you get sources and cited findings, not a comparison table.
- **No change detection.** Retrieval is cached for 30 minutes per URL, and nothing
  re-reads a page or notices it changed while you are talking. A new question, or
  `deepen`, is what causes fresh reads.
- **Session-scoped.** A refresh clears datasets, the canvas and the transcript. Only
  saved report templates (localStorage) and the retrieval cache (sessionStorage)
  survive it.
- **Vendor quota is a real failure mode.** A depleted ElevenLabs character allowance
  means the agent cannot speak, and exhausted context.dev credits mean no research at
  all. `pnpm preflight` reports both before you find out live.
