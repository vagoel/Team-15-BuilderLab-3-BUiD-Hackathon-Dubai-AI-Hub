# Scry — Technical Specification

Voice-driven web research that builds its own dashboard. Code lives in `loom/`
(directory name predates the rename from Loom). Setup and commands: [README.md](README.md).

## 1. Problem

Someone needs to compare current facts spread across several web pages — nightly
rates, model pricing, tuition fees, award winners — and wants to interrogate the
result rather than read a paragraph about it. Chat gives them prose: a comparison
flattened into sentences, where every refinement costs another round of typing and
re-reading.

Voice makes that worse before it makes it better. Speech is excellent at *intent*
("only the ones under fifty", "sort by price", "make it a pie chart") and terrible at
*output* — nobody can hold twelve rows read aloud. So the useful split is: the voice
carries the instruction, the screen carries the data. That is only possible if the
interface is generated in response to what was found, which is exactly what a chat
transcript cannot do.

Scry is for that person: hands busy, presenting, or simply faster at talking than
typing, who wants a comparison they can point at and keep changing by voice. The
system prompt (`loom/src/voice/agentConfig.ts`) enforces the split literally — two
sentences per turn maximum, never read a table aloud, "it's all in the table now".

## 2. Architecture

Everything except the conversation itself runs in one browser tab. There is no
backend of ours in the request path — the only server-side code is a proxy whose
entire job is to hold one API key.

```
  speech / typed text
        │
        ▼
  ElevenLabs agent  ──── ASR, TTS, turn-taking, tool selection, reasoning model
        │                (public agent — the browser connects with no credential)
        │  client tool call
        ▼
  ┌─────────────────────── browser ────────────────────────────────────────┐
  │ toolHandlers.ts → zod validation (the same schemas that declared the    │
  │                   tool to ElevenLabs, so names cannot drift)            │
  │      │                                                                  │
  │      ├─ search_web / use_direct_urls → sourceSets.ts                    │
  │      │        registers candidates, hands back an id + indexes          │
  │      ├─ collect_sources → pipeline.ts → Promise.allSettled over sources │
  │      │        each page → scrape/markdown | crawl | scrape/images       │
  │      │        markdownTable.ts turns real printed tables into rows      │
  │      │                                                                  │
  │      ├──────────────── writes ─────► Zustand store (store.ts)           │
  │      │                                   │                              │
  │      └── get_ui_state ◄── reads ─────────┤                              │
  │                                          ▼                              │
  │                            autoLayout → Canvas.tsx → React renders rows │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │  fetch("/api/context/v1/…")  — same origin, no key
                               ▼
      dev: Vite proxy (vite.config.ts)  │  prod: Vercel fn (loom/api/context.ts)
                     adds Authorization: Bearer $CONTEXT_DEV_API_KEY
                               ▼
                     https://api.context.dev
```

**When and from where data is pulled.** Only when you ask, and only from pages a
search actually returned or you dictated yourself. A live demo looks like this: you
ask a question → `search_web` hits `/v1/web/search` and comes back with up to ten real
candidates → the agent picks two to four by index and calls `collect_sources` →
`/v1/web/scrape/markdown` (or `/v1/web/crawl`, or `/v1/web/scrape/images`) runs over
those pages in parallel → a provisional source list mounts immediately and each source
fills in as it lands → when the last settles, the full dashboard is on screen. The
agent says one sentence. Then you talk to the dashboard. Retrieval is cached for 30
minutes per URL, in memory and `sessionStorage`; a repeat of the same page inside that
window is served warm.

**Data changing mid-conversation is not handled, and nothing pretends otherwise.**
There is no polling, no revalidation, no change detection — a dataset is a snapshot of
what those pages said when they were read. What *is* handled is a dataset growing:
`deepen` re-reads a dataset's sources following their links and merges the new rows
**in place, under the same id**, so every component already bound to it updates without
a re-render; and `collect_sources` with `report_mode: "add"` joins a second dataset to
the canvas instead of replacing the first.

**The model routes; it never carries the data.** `collect_sources` returns a dataset
id, a headline, three key findings and some counts — roughly two hundred tokens. The
rows go straight into the store, and the canvas reads them from there. Turn latency
and token cost are flat whether the table has four rows or four hundred and eighty-seven.

## 3. Tool rationale

**ElevenLabs Agents** owns the conversation and nothing else. Beyond speech in and
speech out, the platform features this build actually depends on:

- **Client tools** — 24 of them, all executing in the browser, generated from the zod
  contract by `toElevenLabsTool()` and pushed by `pnpm sync-agent`. Per-tool
  `expects_response` marks the ones whose return value changes what the agent says
  next (`search_web`, `collect_sources`, `get_ui_state`, `set_filter`, …); the rest
  fire and forget.
- **`pre_tool_speech`** on the slow tools ("Let me search for that.", "Reading those
  now.", "Adding that in now.") so a multi-second web read is never dead air.
- **Dynamic variables**, not prompt overrides: the selected report template is
  serialised into `{{report_template_context}}` at session start. Prompt overrides
  would mean any browser could rewrite a public agent's instructions.
- **Two transports for one agent**: WebRTC for voice, WebSocket for text-only. Typing
  without ever granting mic permission is a first-class path, not a fallback.
- **Server-side agent config as code**: `scripts/sync-agent.ts` pushes the prompt, the
  tool set (replaced wholesale, so a renamed tool cannot linger and 404 mid-demo),
  `temperature: 0.3`, `response_timeout_secs` of 120 for retrieval and 30 for
  everything else, `first_message`, and `enable_auth: false`. The agent's reasoning
  model is pinned there too (the `llm` field in the config PATCH) rather than left on
  a dashboard default — a small fast model could not hold a 24-tool contract and
  looped on invalid calls, and the comment above that line records which one and why.
  Voice/TTS settings are configured in the ElevenLabs dashboard and are not in this
  repo.

Personality is prompt design, not a persona blurb: never answer from memory, never say
you cannot access current information, never read numbers like a machine ("just under
two million"), never announce progress, reach for `undo` the instant a correction
lands because speech gets misheard constantly, and "zero rows is a real result, not a
failure to hide".

**context.dev** is the live-web layer. One key buys five endpoints the app calls
directly (`loom/src/research/context.ts`): `web/search` for discovery, and
`web/scrape/markdown`, `web/crawl`, `web/scrape/images` for retrieval, plus
`brand/retrieve` for source logos and colours. Search and retrieval are deliberately
kept as *separate* calls so the agent chooses candidates from titles and descriptions
and only then spends a retrieval call on the ones it picked — scraping ten pages to
read three is the expensive mistake the design avoids. Its LLM-backed structured
extraction endpoint was tried and **removed**: it summarised long list pages no matter
how the instructions were worded (one record returned from a page holding 487), cost
about 22 s per URL, and produced rows nobody could trace to anything on the page. Raw
markdown plus deterministic table parsing runs in about a second and is exhaustive.

**Devin was not used.** There is no Devin dependency, integration, config, or code path
anywhere in this repository — checked. The only external services the product touches
are ElevenLabs and context.dev; everything else is local (pnpm, Vite, React 19,
TypeScript, Zustand, zod, TanStack Table/Virtual, react-grid-layout) and Vercel for
hosting.

## 4. Feasibility

The scope was cut around one path that was never allowed to break: **one spoken
question → live web read → a dashboard assembles itself → one spoken command changes
it.** `loom/PLAN.md` §8 writes down the cut list in order (brand styling → `deepen` →
chart → timeline) and the one line that could not be cut.

The cuts that made it fit:

- **No backend.** Every tool is a client tool; `SERVER_TOOLS` is empty. The only
  server-side code is a ~90-line key-holding proxy. No database, no auth, no
  persistence beyond `localStorage` templates and a `sessionStorage` cache.
- **No structured-extraction dependency.** Dropping `/web/extract` removed a ~22 s
  per-URL step *and* the class of bug where the report contains rows no one can find
  on the page.
- **Six frozen component types**, and a deterministic `autoLayout` that derives the
  dashboard from the dataset. The model names components; it does not author a UI
  spec. That was forced by ElevenLabs' JSON Schema subset (`PLAN.md` §9) and turned
  out to be the better design — there is nothing left for the model to get wrong.
- **One typed contract, two consumers.** `src/contract/tools.ts` both declares the
  tools to ElevenLabs and validates incoming calls, which is what let the canvas,
  research and voice layers be built in parallel against a frozen interface.
- **Hard spend caps in code** (`contract/artifacts.ts`): 8 sources per collect, 5
  crawl pages by default and 12 maximum, 24 images per source, 1500 characters of page
  text ever returned to the model.
- **`pnpm preflight`** — keys, quotas, agent, attached tool names, and live endpoint
  checks in about thirty seconds. Every check in it exists because that exact thing
  failed once.

The evidence is in the history: the repository's commits run from 11:04 to 14:12 on
2026-08-08 — roughly three hours of event-day work from four contributors on parallel
branches (canvas/layout, PDF report, UI redesign, research), merged in, on top of the
pre-event scaffold described in `PLAN.md` §8. 18 test files and 188 tests, all
offline, pass on the current tree.

**The hardest problem solved** was getting trustworthy rows out of raw pages. Two
things nearly sank it. First, HTML `rowspan` disappears when a table is flattened to
markdown: Wikipedia's award tables span *both* ends of a row, so nominee rows arrive
missing a leading column and a trailing one, and the obvious "left-align and pad" puts
roles in the film column — data that looks real and is not. `markdownTable.ts` solves
it by trying every contiguous placement of the row's cells and keeping the one that
conflicts least with the column *shapes* (year / citation / empty / text) established
by the last full-width row, inheriting spanned cells from the row directly above.
Second, a page's single logical table is often printed as eleven per-decade tables;
grouping by header signature is the difference between 40 rows and 487.

Two more worth naming. The **provenance boundary** (`research/sourceSets.ts`) is what
stops the model inventing URLs — not by asking it nicely, but by making retrieval take
a source-set id and integer indexes, so a composed URL has no way in; the same rule
covers findings, where `set_research_findings` rejects any `sourceId` not belonging to
that dataset. And **ElevenLabs' JSON Schema subset cannot express a union** — a
five-way component union reached the model as an untyped object and it looped; a
`string | number` filter value collapsed to `"object"` and every `set_filter` failed.
The fix lives in `toElevenLabsTool`: whitelist the keys they accept, collapse
primitive unions to `string`, and recompute `required` from zod's own `isOptional()`
rather than the emitted schema (a `z.preprocess` input type is `unknown`, which made a
mandatory field look optional). A test walks every generated schema and fails if a
scalar is ever declared as an object again.

## 5. Extensibility

What v2 looks like, in the order it would be worth building:

1. **A real server tool path.** The contract already carries a `kind: "server" |
   "client"` field and `toElevenLabsTool` already emits webhook declarations — moving
   research behind a server is a one-line change here plus a URL, and nothing else in
   the app learns about it. That buys shared caching, spend control per user, and
   research that survives the tab closing.
2. **Persistence and sharing.** Datasets, source snapshots and dashboard layouts saved
   server-side, so a report can be reopened, linked, or handed to someone else. The
   report templates already prove the data-free-recipe half of this works.
3. **Change awareness — properly.** Store each source's fetch time and content hash,
   re-read on demand, and diff: "three of these prices moved since you asked." That is
   a genuinely new server feature, not a relabelling of the current request-time
   pipeline, and it is the honest way to answer "what if the data changes mid-conversation".
4. **Field-level provenance.** Every row already carries the `_source` it was parsed
   from; pushing that down to the cell and surfacing it as
   click-to-see-it-on-the-page would close the loop between "the dashboard says X" and
   "here is where X was printed".
5. **More bounded components** — maps, timelines, diff views — added to the frozen
   registry, never arbitrary model-authored markup.
6. **Multi-user hardening**: accounts, per-key quotas, observability on tool-call
   failure rates, and graceful degradation when a vendor is down or out of credit.

The invariant that must survive all of it: the model states intent, services fetch
pages, and deterministic application code owns the rows and the rendered interface.
