# Loom

**Voice-driven research that builds its own interface.**

Ask a question out loud. Loom reads the live web, narrates what it finds as it finds
it, and assembles a dashboard in front of you while it talks. Then you keep talking —
to the dashboard. *"Drop anything over two million."* *"Chart it."* *"What's that
outlier?"*

The voice is the interface. The UI is what the voice produces.

---

## Architecture

```
  voice ──► ElevenLabs Agent
              │
              │  ┌── search_web(query) ─────────────────────┐
              │  │   browser ──► /api/context/v1/web/search     │
              │  │   └──► { sourceSetId, numbered candidates }  │
              ├──┤                                              │
              │  ├── collect_sources(sourceSetId, indexes, mode)│
              │  │   browser ──► /api/context/* ──► context.dev │
              │  │       │        (Vite proxy holds the key)    │
              │  │       │        markdown | crawl | images     │
              │  │       └──► dataset store (zustand)           │
              │  │                    │                         │
              │  └────── { datasetId, headline, keyFindings } ──┘
              │                             ~200 tokens
              │
              └── (dashboard mounts itself from the dataset)
                              │
                              ▼
                     Canvas reads rows straight from the store
```

Three decisions carry the whole design:

**1. The model routes, it does not carry.** Research results never travel through the
language model. `research` returns a dataset id, a headline and three findings —
about 200 tokens whether the run pulled 6 rows or 600. The canvas reads the actual
rows from the store. Turn latency is flat with respect to data volume.

**2. The agent never picks a URL, and never invents a row.** Research is two steps:
`search_web` finds real pages and returns numbered candidates; `collect_sources` reads
the ones the agent chose *by index*. No parameter anywhere accepts a raw URL, so a
plausible-looking address the model composed cannot be fetched. The one exception is
`use_direct_urls`, for URLs the user actually said.

What comes back is raw: markdown, crawled pages, or image metadata. Rows are parsed
deterministically out of tables the page genuinely printed — `markdownTable.ts` handles
the awkward parts, including Wikipedia's `rowspan`-flattened cells and tables split
across eleven per-decade blocks (487 rows from one page).

> **This is a deliberate loss of coverage and a gain in honesty.** Loom used to call
> context.dev's `/web/extract`, an LLM that fills a schema you design. It summarised:
> that same 487-row page came back as *one* record, and nothing distinguished rows that
> were read from rows that were composed. The endpoint is gone. A prose page now yields
> **zero rows** — the agent reads it with `read_source` and writes cited findings
> instead, each tagged with the source id it came from, and the tool result says in
> words that no table was produced so the agent cannot imply otherwise.

**3. The model states intent; the app decides presentation.** The dashboard builds
itself from the dataset — `src/canvas/autoLayout.ts` picks the category to group by,
charts the money column ahead of any other number, and drops any component the data
cannot support rather than mounting it broken. The agent only names which components
it wants.

> **This one was learned the hard way, twice.** `render_ui` originally took a whole
> `UiSpec` — a five-way discriminated union. ElevenLabs accepts only a narrow subset
> of JSON Schema: no unions, no validation keywords, and every nested property needs
> a description or the sync 422s. So the union reached the model as an untyped object,
> it guessed the shape, guessed wrong, and looped on the same invalid spec. Explaining
> the shape harder did not fix it. Making the tool flat did: a dataset id and a list
> of five known words, with nothing left to get wrong.
>
> The same collapse then bit `value: string | number` on `set_filter`, which the model
> was told was an object — so it sent one, and every filter call was rejected. Unions
> of primitives now collapse to `string`, and a test walks every tool's generated
> schema and fails if any scalar field is ever declared to the model as an object
> again.

## Latency

Measured against context.dev with our own key before the event:

| Call | Cold | Warm |
|---|---|---|
| `web/search`, 10 results | ~2.4 s | — |
| `scrape/markdown`, 32 KB page | 3.39 s | 0.90 s |
| `scrape/markdown`, 300 KB page | ~1 s | cached |

The retired `/web/extract` path cost ~22 s per URL by itself, which is most of what the
two-step flow above gives back.

That gap is why there is a cache layer and why every source is fetched in parallel.
Progress streams into the UI as each page lands, so source cards appear one at a time
while the agent is still speaking — research time becomes content instead of silence.
Tools also carry spoken pre-roll so there is never dead air.

## Layout

An app-in-app. A 340 px conversation rail on the left; the research canvas — the
actual product — takes the rest. Chat is a transcript, not the point.

## Running it

```bash
pnpm install
pnpm dev
```

Secrets are read from the workspace `.env` one directory up, in `vite.config.ts`, on
the Node side. Required keys:

| Key | Purpose | Secret? |
|---|---|---|
| `CONTEXT_DEV_API_KEY` | Injected as a header by the dev proxy | Yes — never reaches the browser |
| `ELEVEN_LABS_API_KEY` | Used by `sync-agent` and `preflight` only, never by the app | Yes — Node-side scripts only |
| `ELEVENLABS_AGENT_ID` | Public agent id, inlined at build time | No — public agents need no key |

The agent is configured from this repo, not by hand in the dashboard.
`src/voice/agentConfig.ts` holds the system prompt and generates the tool declarations
from the contract; `scripts/sync-agent.ts` pushes both. `agent-prompt.md` is a
paste-able copy for reference only — the sync reads the constant, deliberately, after
an early version pushed the markdown wrapper and the agent read "paste this into the
dashboard" as its instructions.

Verify no key reaches the browser at any time:

```bash
pnpm build && grep -rE "ctxt_secret|xi-api-key" dist/
```

That should find nothing. The only credential-shaped string in the bundle is the agent
id, which is public by design.

> The dev proxy is a development affordance. A public deployment needs it
> reimplemented as an edge function — the browser must never hold the context.dev key.

## Layout of the code

| Path | Role |
|---|---|
| `src/contract/` | Zod schemas for every tool, the UI spec, and the dataset. Single source of truth |
| `src/store.ts` | Zustand store. React state is the only truth; the agent mutates through actions and reads back through `get_ui_state` |
| `src/research/` | context.dev raw clients, source-set provenance, warm cache, pipeline |
| `src/canvas/` | Spec renderer, auto-layout, template placement, and the six components |
| `src/canvas/autoLayout.ts` | Turns a dataset into a dashboard, so the model never has to |
| `src/report/` | Builds a pure report model and renders the print/PDF preview in the browser |
| `mock/` | Vite dev plugin serving mock tables and the pre-researched datasets over HTTP |
| `scripts/` | `preflight` (go/no-go) and `sync-agent` (push the contract to ElevenLabs) |
| `src/voice/` | ElevenLabs session, tool handlers, agent config generator |
| `src/chat/` | The conversation rail |
| `src/templates/` | Saved report layouts: capture, local storage, and the far-left rail |
| `src/lib/filter.ts` | Filter + format logic shared by the table, the chart and `get_ui_state` so all three agree on row counts |

## Report templates

A finished report can be saved as a reusable layout from the collapsed rail on the far
left. Templates are **layout recipes, not copied reports**: capture keeps component
kinds, order and column spans, and strips every data binding — dataset ids, field keys,
chart axes, filters, values, titles. That is what lets a layout saved from a pricing
comparison be selected for a restaurant report and still make sense.

They live in `localStorage` only, versioned and re-validated on every read, so a
corrupt or older entry is dropped individually rather than breaking startup.

Selection is injected two ways at once, on purpose:

- the serialized recipe goes to ElevenLabs as a `report_template_context` dynamic
  variable, so the agent aims its research at the slots it will have to fill;
- the same snapshot is applied by `canvas/templateLayout.ts`, because being *told*
  about a template is not enforcement.

The snapshot is pinned when the session starts and the rail locks until it ends —
otherwise the agent's instructions and the rendered canvas could disagree mid-call.
With no template selected the variable is `NONE` and layout stays adaptive.

## Tools the agent can call

**Getting data in**

| Tool | Does |
|---|---|
| `search_web` | Find real pages. Returns a source set and numbered candidates; reads nothing |
| `use_direct_urls` | Register URLs the user supplied, skipping search |
| `collect_sources` | Read chosen candidates by index — `markdown`, bounded `crawl`, or `images` |
| `set_research_findings` | Add findings the agent read itself; each needs a source id from this dataset |
| `deepen` | Extend an existing dataset in place with another angle |
| `read_source` | Full text of one source, truncated before it reaches the model |
| `mock_data` | Load a pre-researched or generated table without spending a credit |

**Changing what is on screen**

| Tool | Does |
|---|---|
| `render_ui` | Replace the dashboard with a named set of components |
| `add_component` / `remove_component` / `move_component` | Change one component without rebuilding |
| `update_component` | Change a component in place — bar to line, say |
| `set_filter` | Filter a table or chart, and report the new row count back |
| `sort_table` | Sort by a column; shares state with the clickable headers |
| `focus_component` | Scroll a component into view and highlight it |
| `scroll_component` | Scroll *inside* a component that has its own scrollbar |
| `get_ui_state` | Read what is currently on screen |

**Exporting**

| Tool | Does |
|---|---|
| `export_report` | Open the current visual dashboard as a print-ready report; a second explicit action opens the browser print dialog for Save as PDF |
| `export_data` | Download the selected table as CSV, including active voice/column filters and sorting |

The same report preview is available through **Preview PDF** in the canvas header. It uses semantic, non-virtualized tables so every filtered row can flow across printed pages, while charts remain vector SVG with grayscale-safe series treatments. The file is produced by the browser’s Save as PDF destination, is not persisted by Loom, and may be long when many rows remain.

Two of these exist because of specific failures. `scroll_component` was missing, so "scroll
down a bit" was answered by `focus_component` twice while the agent claimed success.
`sort_table` writes the same state a header click writes, because a grid that owns its own
sort state would let the voice and the screen drift apart — which is also why the table is
built on headless TanStack rather than a batteries-included grid.

`get_ui_state` is what stops the voice and the screen from disagreeing.

## Before you demo

```bash
pnpm preflight
```

Checks both API keys, the remaining quota on each, that the agent exists with all its
tools attached and public auth, and that context.dev can actually search and scrape.
Exits non-zero if anything blocking is wrong. Every check in it is there because that
exact thing failed at least once during the build.

```bash
pnpm preflight --deep
```

Also exercises the costlier raw capabilities — a bounded crawl and an image scrape —
and measures markdown latency across three live pages, printing the credits each call
consumed. These stay out of the basic check because crawl bills per page.

```bash
pnpm sync-agent
```

Pushes the tool contract and system prompt to ElevenLabs. On a fresh account it creates
the agent too and prints the `ELEVENLABS_AGENT_ID` line to add to `.env`. It also
regenerates `agent-prompt.md`, and a test fails if that copy ever drifts.

### The one thing no test covers

`useVoiceSession`'s React lifecycle has no automated coverage — there is no jsdom in
this project, so the two riskiest decisions were extracted into pure functions and
tested there, but the callback wiring itself is only verified by the type checker.
Two genuine bugs lived in exactly that gap: after any disconnect the app did not
initiate — a dropped wifi, a server hangup — the session reference was never cleared,
which made the Start button a permanent no-op until a page reload; and pressing Stop
while still connecting was silently swallowed, leaving a live mic session running.

Both are fixed. Neither would have shown up in code review. So before going on stage,
spend two minutes on the mic button by hand:

1. Double-click **Start** — one session, not two.
2. Click **Stop** while it is still connecting — it should stay stopped.
3. Turn wifi off for a second mid-session, then back on — **Start** must work again.

## Mock mode

Extraction costs credits and takes about 22 seconds a page, which makes the canvas
awkward to build against. `mock_data` loads a table instantly instead:

- `llm_pricing`, `dubai_rent`, `gpu_cloud` — **real** figures compiled from real pages,
  with genuine source URLs. Gaps are left null rather than filled in.
- `sales`, `employees`, `models`, `weather`, `market_share`, `numbers` — generated
  filler for exercising the interface at scale, seeded so the same request always
  returns the same rows.

Generated data labels itself as synthetic in the headline, the source list and the
findings, so a mock dashboard cannot be mistaken for research in a screenshot. The
prompt only lets the agent reach for it when the user explicitly asks for sample data —
never to paper over thin research.

`?dev` opens a harness that drives every tool by button, and `?demo` boots straight into
a populated dashboard.

## Tests

```bash
pnpm test
```

Tests cover where the risk actually is — the research pipeline's parallelism and
failure degradation, and the tool handlers' validation (including the model sending a
JSON string where an object was declared, which is the most common real failure).
They run offline against stubbed fetch.

## Further reading

[BUILDING.md](BUILDING.md) — how to build this from scratch: the stack choices and
their alternatives, the four decisions that carry the design, and the traps that cost
real hours (a schema subset that lies to your model, `Number("") === 0`, a timeout set
below the measured latency it guards).

[PLAN.md](PLAN.md) — the build plan, the cut list, and the risks with mitigations
decided in advance.
