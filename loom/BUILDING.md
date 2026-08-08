# Building Loom from scratch

A voice agent that researches the live web and builds its own dashboard as it talks.
This is what I would tell someone starting the same project tomorrow morning.

---

## The idea in one line

The model states **intent**; the app decides **presentation**. Voice is the interface,
the UI is what the voice produces, and the data never travels through the model.

## Stack, and why each piece

| Piece | Choice | Why not the obvious alternative |
|---|---|---|
| Voice loop | ElevenLabs Agents (managed) | Custom-LLM mode means hosting an endpoint and adding a network hop per turn. Managed gives you Opus 4.8 with no key of your own |
| Live data | context.dev raw web APIs (`search`, `scrape/markdown`, `crawl`, `scrape/images`) | ~~`extract`~~ was tried first and cut: the LLM behind it summarised long list pages (one record from a page holding 487) and gave no way to tell a read row from a composed one. Raw markdown plus a deterministic table parser is exhaustive and auditable |
| UI state | zustand | The agent and the user both mutate the same store. A component library that owns its own state gives you two truths |
| Table | TanStack (headless) | AG Grid/MUI own sorting internally. Then a voice sort and a header click disagree, and `get_ui_state` starts lying to the agent |
| Charts | Hand-rolled SVG | ~300 lines, zero bundle, and it matches the theme. Recharts would have cost more in fighting than it saved |
| Framework for agent-UI | **None** | CopilotKit and assistant-ui both want to own the conversation loop. That loop already belongs to the voice agent — take the *pattern*, not the framework |

## Four decisions that carry the whole design

**1. The model routes, it does not carry.** `research` returns a dataset id, a
headline and three findings — about 200 tokens whether the run pulled 6 rows or 600.
The canvas reads the rows from the store directly. Turn latency stays flat with data
volume.

**2. The agent designs the schema, the API does the reading.** Before researching, the
model authors the `fields` array — it decides that comparing apartments means `area`,
`price_aed`, `beds`. context.dev fills that schema from every page in parallel.

**3. The dashboard builds itself.** `autoLayout` derives the layout from the dataset:
pick the lowest-cardinality text column to group by, chart the money column ahead of
any other number, drop any component the data cannot support. The agent only names
which components it wants. This started as "the agent emits a UI spec" and had to be
walked back — see the traps.

**4. One typed contract, generated both ways.** Zod schemas define every tool. The
handlers validate against them; the ElevenLabs agent config is generated from them.
A tool name or parameter cannot drift between code and dashboard.

## The traps that actually cost hours

**The schema subset will lie to your model — four times.** ElevenLabs accepts a narrow
slice of JSON Schema: no unions, no validation keywords, and every nested property
needs a description or the sync 422s. Every time a union collapsed, the model believed
the collapsed type and failed:

- A five-way component union became `{"type":"object"}` → the model guessed the shape and looped on invalid specs forever
- `value: string | number` became `object` → every `set_filter` call rejected
- A `z.preprocess` made `value`'s *input* type `unknown` → it silently dropped out of `required`
- A free-form `z.record` patch had no properties → the model sent `{}`, the handler applied nothing and reported success, and the agent announced "it's a pie chart now" over an unchanged bar chart

**Write a test that walks every generated schema and fails if any scalar is declared
as an object.** Do it on day one. Then keep tool parameters flat and boring: ids and
enums, never a nested union.

**`Number("") === 0`.** Filters coerced both sides to numbers before comparing, so
stripping the letters out of a text cell produced `0`, and every text value equalled
every other. `product eq Drift` matched all 120 rows. Silent wrong answers beat
crashes for damage.

**Set the timeout from a measurement, not a guess.** Extraction measures ~22s; the
abort budget was 20s. Every live call would have aborted a fraction before returning
and fallen back to heuristic parsing — producing convincing rows that came from
nowhere. Measure the slow call before you trust any number near it.

**A failing tool call costs money.** The agent narrates every retry aloud. One
malformed-spec loop consumed an entire 10,000-character TTS free tier in a single
session. Tool errors must be short, actionable and self-correcting, and the prompt
must forbid narrating progress or repeating itself.

**Never fabricate to fill a gap.** Research has holes; leave them null. A heuristic
fallback that invents a plausible row for a 404 page is the worst possible failure on
stage, because nobody can tell.

## Build order, starting from zero

1. **Freeze the tool contract first** — one Zod module, an hour of thinking. Everything
   else can then be built in parallel against it. This is the whole reason three
   agents could work at once without collisions.
2. Store + shared filter logic. React state is the only truth.
3. Canvas and components, driven by a seeded fixture — no network, no voice.
4. Research pipeline, parallel fetch, warm cache.
5. Voice session and tool handlers last, once everything they call already works.
6. `preflight` — one command that checks both keys, quota, the agent, and whether the
   APIs actually respond. Write it early; every check will earn its place.

## What I would do differently

- **Build mock mode on day one, not day two.** Extraction costs credits and takes 22s
  a page. Being able to put 100 real-shaped rows on screen in a second is what makes
  the UI buildable at all.
- **Add jsdom immediately.** The two worst bugs found were React lifecycle bugs in the
  voice hook — a dead session reference that made the mic button a permanent no-op
  after any disconnect, and a Stop press swallowed mid-connect. Neither was testable
  without a DOM, and neither shows up in review.
- **Never sync a prompt from a markdown file.** `agent-prompt.md` opened with "Paste
  this into the dashboard", and the agent read that as its instructions — it behaved
  like a documentation reader and refused to research anything. Sync from the constant;
  generate the markdown.
- **Expect the model to guess when you tell it nothing**, and assume every guess is
  wrong in the most confident way possible.
