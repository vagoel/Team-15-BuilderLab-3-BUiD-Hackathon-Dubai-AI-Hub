# Product

## Name

**Scry** (rhymes with "sky"). To scry is to gaze at a surface and see what was hidden — which is exactly the experience: ask a question, then watch the real answer take shape on the canvas from real, cited sources.

We build the brand on the **"see clearly"** reading of the word, not the fortune-telling one. Scry is a precision instrument, not a crystal ball: every number is sourced and traceable. No occult/mystic styling (no crystal balls, no purple-wizard palette); the name is evocative, the execution is exact. That tension — an evocative name over a rigorous tool — is deliberate and is what makes it stick.

- **Wordmark:** Scry
- **Tagline:** *Say it, watch it take shape.*
- Renamed from "Loom" to avoid collision with loom.com (screen recording) and to sharpen the identity.

## Register

product

## Users

People who need to **compare current information from several web pages and act on it hands-free**. Two overlapping profiles:

- **The comparer** — someone weighing concrete options against live numbers: apartments by price and size, phones by spec, funds by return, suppliers by lead time. They think out loud, change their mind mid-thought, and want the numbers side by side rather than buried in prose.
- **The presenter** — someone driving Scry in front of others (a demo, a stakeholder call, a class). They talk, the dashboard responds, and the room watches data assemble itself. The screen has to read from across a room.

**Context of use:** at a desk or presenting, microphone on, one research question at a time, iterating by voice ("drop anything over two million," "sort by price," "chart it," "export this"). Sessions are short-to-medium and single-topic. There is no login, no persistence — a refresh is a fresh start. Both voice and typed input are first-class.

**Job to be done (spec's own words):** *"compare current information from several web pages and manipulate the result hands-free."* Scry is an **on-demand research tool, not a crawler or monitor** — it reads pages when asked and never runs a background loop.

## Product Purpose

Web research over chat collapses into prose: facts are mixed into paragraphs, comparisons are hard to scan, every follow-up needs another prompt — and this is worse over voice, where reading rows and prices aloud is slow and forgettable.

Scry splits the labor: **the voice carries the conversation, the canvas carries the data.** You ask a question; an ElevenLabs agent picks the sources and designs the field schema; context.dev extracts structured rows from live pages; and the app lays them out automatically as stat cards, a chart, a filterable table, findings, and a source list. You then keep talking — to the dashboard.

Success looks like: a spoken question becomes a scannable, trustworthy, manipulable dashboard **while the agent is still talking**, and every number on screen traces back to a source. The research time becomes visible content, never a blank spinner.

## Brand Personality

**Alive, precise, quietly confident.**

- **Alive** — the interface responds to the voice in real time: the mic breathes with your amplitude, sources land one at a time, components rise into place as data arrives. It feels like something is *happening*, not loading.
- **Precise** — numbers are the point. Tabular figures, honest units, source citations, no rounding away the truth. The craft is in legibility, not decoration.
- **Quietly confident** — it does something genuinely hard and doesn't shout about it. No badges, no confetti, no marketing gloss. The data is the flex.

Voice/tone: plain, specific, second person. Labels say what will happen ("Export table", not "OK"). Findings state facts, not vibes.

## Anti-references

Explicitly NOT any of these:

- **Generic SaaS / Linear clone** — the default startup-dashboard look: neutral gray, one blue accent, indistinguishable from every other tool. (This is close to where the current UI is today.)
- **Bland AI-default** — cream/beige backgrounds, gradient text, tiny uppercase tracked eyebrows above every section, endless identical icon-heading-text card grids, hero-metric templates.
- **Overstimulating / gamified** — many competing colors, bouncy/elastic motion, decorative animation that doesn't convey state. A serious research tool can't feel like a game.
- **Corporate / enterprise stiff** — cold, joyless, dense-for-density's-sake, Bloomberg-terminal-without-craft. Precision without warmth.

The line to walk: **a research instrument with craft** — closer to a well-made scientific tool or a premium trading terminal that someone actually loved designing, than to either a toy or a spreadsheet.

## Design Principles

1. **The voice leads; the UI is the artifact.** The screen is what the voice *produced*, not a competing control panel. Every on-screen affordance should also be reachable by speaking. Chrome recedes; the produced data dominates.
2. **Research time is content, not waiting.** Progress, source cards, and components stream in as the work happens. There is never a dead blank spinner while the agent talks — the assembly *is* the show.
3. **Data is the hero; the interface disappears into the task.** The chart, table, and numbers carry the screen. The tool earns trust by being legible from across a room, not by being decorated.
4. **The screen and the voice never disagree.** One source of truth (the store); voice commands and direct clicks write the same state; `get_ui_state` lets the agent read exactly what the user sees. No drift between what's said and what's shown.
5. **Honesty over polish-theater.** Every number traces to a source. Loading, empty, "couldn't read," and error states are designed, not hidden. A plausible wrong answer is worse than an honest gap.

## Accessibility & Inclusion

- **Target: WCAG 2.1 AA.** Body text ≥4.5:1, large/bold text ≥3:1, including the small 9–13px labels and chart axis text that are currently borderline.
- **Keyboard-operable throughout.** Visible focus states on every interactive element; sortable table headers operable and announced (`aria-sort`); no mouse-only affordances.
- **Voice-first is an accessibility strength — extend it.** The product is already usable hands-free; the visual layer must be equally usable for keyboard and screen-reader users. Charts need text alternatives (`role="img"` + summary); citations need meaningful link text.
- **Respect `prefers-reduced-motion`.** Every entrance/pulse/draw animation needs a reduced-motion alternative (crossfade or instant). Motion must convey state, never decorate.
- **Both themes meet contrast.** Light and dark are held to the same AA bar; no washed-out muted text on tinted surfaces.
