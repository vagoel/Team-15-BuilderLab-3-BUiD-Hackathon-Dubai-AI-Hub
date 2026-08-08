# Loom — build plan

Voice-driven research that builds its own interface.

You speak a research question. Loom goes and reads the live web, narrates what it
finds as it finds it, and assembles a dashboard in front of you while it talks.
Then you keep talking — to the dashboard.

---

> **Superseded (2026-08-08).** Everything below describing context.dev `/web/extract`
> — the structured-extraction endpoint, its ~22s budget, its JSON-Schema `fields`
> contract and the heuristic fallback behind it — is historical. That path was removed
> in favour of search-first raw retrieval (`web/search` → `scrape/markdown` | `crawl` |
> `scrape/images`) with deterministic markdown-table parsing. See README.md
> "Architecture" and `src/research/context.ts`. The rest of this plan still stands.


## 1. The one-paragraph pitch

Chat gives you a wall of text. Loom gives you an interface. Ask *"compare 2-bedroom
prices in Dubai Marina and JVC"* and the answer isn't a paragraph — it's a live
comparison table, three stat cards and a chart that assembled themselves from pages
read seconds ago. Then say *"drop anything over two million"* and the table filters.
Say *"chart it"* and the table becomes a chart. The voice is the interface; the UI is
what the voice produces.

## 2. Why this shape

Three sponsor tools, three jobs, no overlap:

| Tool | Job | Not its job |
|---|---|---|
| context.dev | Read the live web into structured data | Deciding anything |
| ElevenLabs Agents | Own the conversation loop; call tools | Rendering |
| React app | Render + hold state | Talking to models |

The judging brief asks for a voice-first agent that knows something real about the
world, built with AI coding agents. Generative UI is the part nobody else in the room
will attempt, and it is the part that only makes sense with a voice interface —
because when you can't type, the interface has to come to you.

## 3. Core architecture decision: the LLM routes, it does not carry

The naive build pipes research results *through* the model so it can hand them to a
render tool. That is slow, expensive, and lossy — a 40-row table becomes 40 rows of
tokens, twice.

Loom splits the path. There is no backend: every tool runs in the browser, and
context.dev is reached through the Vite dev proxy, which holds the key on the Node
side so it never enters the bundle.

```
  voice ──► ElevenLabs Agent
              │
              │  ┌── research(question, seedUrls, fields) ──┐
              ├──┤                                          │
              │  │   browser ──► /api/context/* ──► context.dev
              │  │       │        (dev proxy holds the key)
              │  │       └──► DatasetStore (zustand)
              │  │                    │
              │  └────── returns { datasetId, headline, keyFindings } ──┐
              │                                          ~200 tokens ───┘
              │
              └── (the dashboard mounts itself from the dataset)
                              │
                              ▼
                     Canvas reads the dataset straight out of the store
                     (bulk rows never touch the model)
```

The agent receives a `datasetId`, a headline and three key findings — roughly 200
tokens. The canvas reads the actual rows from the store itself. Turn latency stays
flat no matter how much data the research pulled.

**The agent designs the schema.** `research` takes a `fields` array the model authors
before it goes looking — it decides that comparing apartments means `area`,
`price_aed`, `beds`, `size_sqft`. context.dev's extraction endpoint then fills that
schema from every page in parallel. The model chooses the shape of the answer; the
API does the reading.

## 4. Generative UI: which pattern

Per the 2026 AG-UI taxonomy there are three patterns — static (agent picks from
pre-built components), declarative (agent emits a JSON UI spec, frontend renders it
under its own constraints), and open-ended (agent emits raw markup).

**Loom ended up nearer the static end than planned, and that was the right move.** The
plan was declarative — the agent emits a JSON spec, we render it. ElevenLabs' schema
subset could not carry the component union, so the model never saw the shape and
looped on invalid specs. It now states intent (which components, in what order) and
`autoLayout` derives the spec. Same outcome on screen, nothing left for the model to
get wrong. See §9.

We deliberately do not adopt CopilotKit or assistant-ui. Both want to own the
conversation loop, and that loop already belongs to the ElevenLabs agent — voice *is*
the thread. We take the pattern, not the framework.

## 5. Component kit — frozen, five types

| Type | Renders | Data shape |
|---|---|---|
| `stat_cards` | Headline numbers | `{ label, value, delta? }[]` |
| `comparison_table` | Virtualised rows on headless TanStack: click-to-sort shared with the voice tool, per-column filters, internal scroll | `{ columns, sort?, filters }` |
| `chart` | Bar, line or donut, hand-rolled SVG. Aggregates by category when the x column repeats | `{ kind, x, y[] }` |
| `source_list` | What was read, with brand marks | `{ url, title, brand }[]` |
| `findings` | Prose bullets with citations | `{ text, source_ids }[]` |

Frozen at hour one and never widened. Adding a sixth costs more than it returns.

## 6. Tool contract

One Zod module in `src/contract/`, imported by the tool handlers (to validate) and by
the agent-config generator (to declare). Names cannot drift apart.

Every tool currently runs in the browser. The `kind` field on each definition is kept
anyway, because moving `research` behind a real server later is a one-line change
here plus a webhook URL — nothing else in the app knows the difference.

**Research tools** — the agent's eyes on the web:

- `research(question, seedUrls, fields)` → `{ datasetId, headline, keyFindings[3], sourceCount, recordCount, availableFields }`
- `deepen(datasetId, angle)` → new dataset extending the old one
- `read_source(sourceId)` → clean text of a single source, truncated before it reaches the model

**UI tools** — the agent's hands on the page:

- `render_ui(datasetId, components[])` → replace the dashboard. Flat by design (§9)
- `add_component` / `remove_component` / `move_component` → change one thing
- `update_component(id, patch)` → change a component in place
- `set_filter(componentId, filters)` → filter a table/chart, reporting the new count
- `sort_table(componentId, field, dir)` → shares state with the clickable headers
- `focus_component(id)` → scroll a component into view and highlight it
- `scroll_component(id, to)` → scroll *inside* a component that has its own scrollbar
- `get_ui_state()` → read back what is currently on screen *(waits for response)*

`get_ui_state` is what stops the voice and the screen from disagreeing. React state
is the single source of truth; the agent mutates only through tools and reads back
through this one.

## 7. Latency plan

Measured against context.dev with our own key, ahead of the event:

| Call | Cold | Warm |
|---|---|---|
| `scrape/markdown` (32KB page) | 3.39s | 0.90s |

Extraction turned out to be the real cost: **~22s per page**, not the 3.4s a scrape
takes. So sources are fetched **in parallel**, progress streams to the UI through
hooks (no SSE — there is no server), and the source list mounts the instant research
starts so the canvas fills within a second rather than sitting blank for twenty.

Agent-side, tools get spoken pre-roll so there is never dead air.

## 8. Build order

Tonight (pre-event scaffold). Steps 3–5 were built in parallel by three agents
working against the frozen contract from step 2 — which is the whole reason freezing
it first was worth the twenty minutes:

1. Single Vite app, dev proxy holding the context.dev key
2. Contract + store + shared filter logic *(the integration surface — hand-written)*
3. Canvas: spec renderer + five components
4. Research: context.dev client, warm cache, parallel pipeline
5. Voice: ElevenLabs session, tool handlers, chat rail
6. Integration, typecheck, tests
7. README + architecture notes

Event day, 09:30–14:30:

| Hour | Focus |
|---|---|
| 1 | Agent configured in dashboard against the tool contract; end-to-end handshake |
| 2 | Research quality — prompt tuning, extraction schemas, real topics |
| 3 | Full loop live: speak → research → UI assembles → speak to the UI |
| 4 | Polish: brand-aware styling, chart, filter-by-voice |
| 5 | Freeze 13:30. Rehearse ×3. Video + README submitted by 14:15 |

**Cut list, in order:** brand styling → `deepen` → chart → timeline.
**Never cut:** one question → research → UI assembles → one voice command changes it.

Before demoing, `pnpm preflight` answers whether it will work at all: both keys, the
quota left on each, the agent and its tools, and whether context.dev can actually
scrape and extract. Every check in it exists because that exact thing failed once.

## 9. Risks — predicted, and what actually happened

The left column is what we wrote down before building. The right is what the build
actually did to us. Keeping both is more useful than quietly rewriting the forecast.

| Predicted | Outcome |
|---|---|
| Research too slow for a live demo | **Worse than predicted.** Extraction is ~22s per page, not the ~3.4s scrape we measured. Mitigated by parallel fetch, a warm cache, and mounting the dashboard the moment research resolves rather than waiting on a second model turn |
| Agent picks bad component types | **Did not happen — because the agent no longer picks.** It states intent; `autoLayout` decides |
| Voice/UI state divergence | **Held.** `get_ui_state` and the table read the same filter logic. The one place it nearly broke was sorting, fixed by making header clicks write the same state the voice tool writes |
| Vendor key leaking into the browser | **Held.** Verified against a real production build; the only credential-shaped string in `dist/` is the public agent id |
| context.dev search endpoint 403s | **Held.** Never depended on it; the agent supplies seed URLs |
| Venue wifi | Untested. The warm cache survives a dead network, but a cold research call will not |

### What actually bit us, that we had not predicted

| Problem | Cost | Now |
|---|---|---|
| **ElevenLabs' JSON Schema subset cannot express a union.** A five-way component union reached the model as an untyped object; it guessed and looped. The same collapse later told the model a filter value was an object, and every `set_filter` failed | Two separate outages, hours | Unions of primitives collapse to `string`; `render_ui` is flat. A test walks every tool's generated schema and fails if any scalar is ever declared as an object again |
| **`Number("") === 0`.** Filters coerced both sides to numbers, so stripping the letters out of a text cell produced 0, and every text value equalled every other. `product eq Drift` matched all 120 rows | Silent wrong answers | A cell with no digits is not a number. Pinned by test |
| **A failing tool call costs money.** The agent narrates each retry aloud, and the render_ui loop consumed an entire TTS free tier in one session | The account's whole quota | Tool errors are short, actionable and self-correcting; the prompt forbids narrating progress or repeating itself |
| **The prompt was synced from the wrong string.** `agent-prompt.md` opens "Paste this into the dashboard", and the agent read that as its instructions — so it behaved like a documentation reader and refused to research | One confusing debugging session | Sync reads the constant. `agent-prompt.md` is generated, and a test fails if it drifts |
| **Deep paths are invented.** The model guessed listing URLs that 404 | Lost sources per run | The prompt says canonical short URLs are real and deep paths are guesses; ask rather than invent |

## 10. What "good codebase" means here

The brief says the codebase is judged. Concretely:

- One typed contract, two consumers, zero drift
- Tests where the risk is — the tool layer and the spec validator, with recorded
  context.dev fixtures so tests run offline
- No vendor key in any client bundle
- Small commits across the day, not one dump at 14:20
- README that opens with the architecture and the latency numbers that justified it
