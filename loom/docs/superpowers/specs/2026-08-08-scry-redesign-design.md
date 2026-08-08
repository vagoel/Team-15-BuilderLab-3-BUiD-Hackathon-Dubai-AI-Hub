# Scry — UI/UX Redesign Design Doc

**Date:** 2026-08-08
**Status:** Draft for review (gates implementation)
**Author:** design pass on branch `nimras-version-ui-fixes`
**Reads with:** `PRODUCT.md` (strategy), `DESIGN.md` (current baseline), `docs/ISSUES.md` (problem list)

---

## 1. Summary

Rename **Loom → Scry** and rebuild the visual and interaction layer around one committed
direction: **Editorial data** — a light-first "research report / data desk" aesthetic on
cool paper, with a **petrol/teal** accent and a **Fraunces · Inter · IBM Plex Mono** type
system. Ship a matching dark counterpart. Replace today's generic SaaS-gray look and its
hand-literal styling with a real design-token system, fix the P0/P1 accessibility gaps,
and make the voice-only actions reachable on screen.

**Decisions locked (with the user):** name = Scry; direction = Editorial data; accent =
petrol `~#0E6E6E` (error red kept distinct); type = Fraunces + Inter + IBM Plex Mono;
light is the default theme, dark is the counterpart, `system` honored.

**Non-goals for this pass:** mobile-first rework (tablet-safe only), per-cell provenance,
persistence/accounts, new component types. These stay in TECH-SPEC §05 (v2).

---

## 2. Design concept

Scry is a precision instrument that reads "beautifully typeset research," not "SaaS
dashboard." The personality (PRODUCT.md) is *alive, precise, quietly confident*. Editorial
data delivers that through **typography and restraint** rather than effects — the hardest
look to fake and the furthest from all four rejected anti-references.

Three ideas carry the visual language:

1. **The page is a document.** Generous margins, a clear reading column in the rail, hairline
   rules instead of heavy cards, a serif voice for headings. The canvas reads like a report
   assembling itself.
2. **Numbers are set, not styled.** All quantitative content is IBM Plex Mono, tabular-lined,
   right-aligned in tables. Money and measures look typeset and trustworthy.
3. **One calm signal.** Petrol is the only accent — live state, selection, primary action,
   the highlighted series. Everything else is ink on paper. Red means *error*, nothing else.

"Scry = watch it take shape" shows up as a **restrained reveal**: components and source
cards settle into place as data lands (see §7), never as decorative motion.

---

## 3. Design tokens

All tokens live in `src/styles.css` on `:root`, in **OKLCH**, driving both themes via the
existing zero-re-render mechanism (`data-theme` + `prefers-color-scheme`). Hex equivalents
are approximate references; OKLCH is source of truth.

### 3.1 Color — Light (default, "cool paper")

| Token | OKLCH | ~hex | Role |
|---|---|---|---|
| `--bg` | `oklch(0.981 0.004 230)` | `#f5f6f8` | page (cool, chroma ~0, **not** cream) |
| `--panel` | `oklch(0.995 0.002 230)` | `#fdfdfe` | card / surface |
| `--panel-2` | `oklch(0.965 0.005 230)` | `#eff1f4` | secondary surface (primary cards) |
| `--rail` | `oklch(0.972 0.004 230)` | `#f2f4f6` | conversation rail (distinct neutral layer) |
| `--line` | `oklch(0.90 0.006 230)` | `#dce0e6` | borders / rules |
| `--line-soft` | `oklch(0.935 0.005 230)` | `#e7eaef` | hairline rules |
| `--ink` | `oklch(0.24 0.02 245)` | `#141a24` | primary text (cool near-black) |
| `--mute` | `oklch(0.44 0.02 245)` | `#4b5568` | secondary text (≥7:1 on paper) |
| `--dim` | `oklch(0.56 0.02 245)` | `#6b7488` | tertiary — **raised to ≥4.5:1**; min size 11px |
| `--accent` | `oklch(0.50 0.088 194)` | `#0e6e6e` | petrol: action / live / selection |
| `--accent-strong` | `oklch(0.44 0.09 194)` | `#0b5c5c` | pressed / active |
| `--accent-soft` | `oklch(0.50 0.088 194 / 0.12)` | — | hover / focus tint |
| `--good` | `oklch(0.55 0.12 150)` | `#2f8f5b` | success (distinct from petrol) |
| `--warn` | `oklch(0.62 0.13 75)` | `#a5730d` | warning |
| `--bad` | `oklch(0.55 0.20 27)` | `#c8352c` | **error only** — deeper/cooler than any accent |
| `--focus` | `oklch(0.50 0.088 194)` | `#0e6e6e` | focus ring (petrol) |
| `--scroll-thumb` | `oklch(0.86 0.006 230)` | `#cdd2da` | scrollbar |

### 3.2 Color — Dark (counterpart)

| Token | OKLCH | ~hex | Role |
|---|---|---|---|
| `--bg` | `oklch(0.19 0.012 245)` | `#0d1218` | deep cool ink |
| `--panel` | `oklch(0.23 0.013 245)` | `#151b23` | card |
| `--panel-2` | `oklch(0.27 0.014 245)` | `#1c232d` | secondary surface |
| `--rail` | `oklch(0.215 0.012 245)` | `#121821` | rail |
| `--line` | `oklch(0.34 0.014 245)` | `#2b333f` | borders |
| `--line-soft` | `oklch(0.29 0.013 245)` | `#212832` | hairline |
| `--ink` | `oklch(0.95 0.006 245)` | `#eef1f6` | primary text |
| `--mute` | `oklch(0.72 0.015 245)` | `#a3adbe` | secondary |
| `--dim` | `oklch(0.60 0.015 245)` | `#7b8598` | tertiary (≥4.5:1 on panel) |
| `--accent` | `oklch(0.74 0.11 190)` | `#40bdb2` | luminous petrol |
| `--accent-strong` | `oklch(0.80 0.11 190)` | `#5fd3c7` | active |
| `--accent-soft` | `oklch(0.74 0.11 190 / 0.16)` | — | hover/focus tint |
| `--good` | `oklch(0.75 0.14 160)` | `#2fce9b` | success |
| `--warn` | `oklch(0.80 0.13 80)` | `#f0b64d` | warning |
| `--bad` | `oklch(0.68 0.18 25)` | `#f26a5f` | error only |
| `--scroll-thumb` | `oklch(0.34 0.014 245)` | `#2b333f` | scrollbar |

### 3.3 Chart series (dataviz-validated ✓)

Validated with `dataviz/scripts/validate_palette.js` against our actual chart surfaces
(`--panel-2`: light `#eef1f4`, dark `#1c232d`). Fixed, entity-stable order — the same slot
maps to the same hue in both themes, only lightness-stepped:

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | teal (brand) | `#0a9d90` | `#1f9f93` |
| 2 | orange | `#d9541f` | `#e06a34` |
| 3 | violet | `#4a3aa7` | `#7c6fe0` |
| 4 | gold | `#c98500` | `#b5831a` |
| 5 | magenta | `#c64f92` | `#d564a0` |
| 6 | green | `#2f9e4f` | `#29a95c` |
| 7 | blue | `#2a78d6` | `#3f83d8` |
| 8 | red | `#e34948` | `#e05654` |

Results: **all checks PASS** both themes — worst adjacent CVD ΔE **36.2** (light) / **32.6**
(dark), well clear of the ≥12 target; lightness band, chroma floor, and contrast all pass.
Two light slots (teal ≈2.97:1, gold ≈2.71:1) trip the sub-3:1 contrast WARN — covered by the
**relief rule** (charts always carry a legend for ≥2 series, and the comparison table is the
table view). Slot 1 leads with brand teal so single-series charts read on-brand; the single
*highlighted* series still uses `--accent` (petrol).

### 3.4 Typography scale (fixed rem — product register, ratio ≈1.2)

| Token | Size | Typical use |
|---|---|---|
| `--text-2xs` | 11px | smallest labels, chart axis (floor; never below) |
| `--text-xs` | 12px | captions, table filter inputs |
| `--text-sm` | 13px | secondary UI, findings meta |
| `--text-base` | 15px | body / default |
| `--text-md` | 17px | emphasized body, subheads |
| `--text-lg` | 20px | canvas subtitle |
| `--text-xl` | 24px | section heading (Fraunces) |
| `--text-2xl` | 30px | canvas title (Fraunces) |
| `--text-3xl` | 38px | empty-state display (Fraunces) |
| `--data-lg` | 34px | stat value (Plex Mono, tabular) |

Weights: Inter 400/500/600; Fraunces 500/600 (with optical sizing); Plex Mono 400/500.

### 3.5 Spacing (4px base)

`--space-1:4 · -2:8 · -3:12 · -4:16 · -5:20 · -6:24 · -8:32 · -10:40 · -12:48 · -16:64`.
Replace all literal paddings/gaps/margins with these.

### 3.6 Radius, elevation, z-index, motion

- **Radius:** `--radius-sm:6 · --radius-md:10 · --radius-lg:14 · --radius-pill:999`.
- **Elevation** (editorial = mostly rules + whisper shadows):
  `--shadow-sm: 0 1px 2px oklch(0.24 0.02 245 / 0.06)`;
  `--shadow-md: 0 4px 16px oklch(0.24 0.02 245 / 0.08)`. Dark uses borders, minimal shadow.
- **Z-index scale:** `--z-base:0 · --z-sticky:100 · --z-dropdown:200 · --z-modal:1000 ·
  --z-toast:1100 · --z-tooltip:1200`.
- **Motion:** `--dur-fast:120ms · --dur:200ms · --dur-slow:320ms`;
  `--ease-out: cubic-bezier(0.22,1,0.36,1)`. All product transitions 120–320ms.

### 3.7 Fonts loading (self-hosted, no CDN)

Add Fontsource variable packages (self-host, CSP-safe, no external request):
`@fontsource-variable/fraunces`, `@fontsource-variable/inter`, `@fontsource/ibm-plex-mono`.
Import in `main.tsx`. Set stacks:
- `--font-display: "Fraunces Variable", Georgia, serif`
- `--font-sans: "Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- `--font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
System stack remains the fallback so first paint is never blank.

---

## 4. Layout & structure

- **Shell unchanged in bones:** `340px rail + 1fr canvas`, `body{overflow:hidden}`, internal
  scroll. Rail gets `--rail` background to read as a distinct "conversation ledger" column.
- **Canvas:** wider reading rhythm — `padding: var(--space-8) var(--space-8) var(--space-16)`,
  `max-width: 1400px`. 12-col grid retained; gaps use `--space-4`.
- **Cards → panels with rules.** Reduce card-heaviness: primary artifacts (chart/table) keep a
  bordered panel; findings/sources become quieter blocks separated by hairline `--line-soft`
  rules rather than full boxes where it reads cleaner. No nested cards.
- **Card/section labels:** replace the uniform uppercase-tracked eyebrow on *every* card
  (ISSUES B4) with a quieter label: sentence-case, `--mute`, `--text-sm`, weight 600 — or a
  small Fraunces label for the two primary artifacts. Eyebrow cadence removed.

---

## 5. Component redesign (per surface)

**Empty / first-run (`Canvas.tsx`)** — the editorial hero.
- Fraunces display line ("Say it, watch it take shape.") + one plain-language sub.
- **Example prompts become actionable** (fixes E1/C6): real `<button>`s that start that
  research (or fill the input + focus it). Clear hover/focus.
- **First-run scaffold** (E2): a quiet one-line hint that you can *talk or type*, and what mic
  permission unlocks. Show the three prompts as "try one."

**Chat rail (`ChatPanel.tsx`)** — the conversation ledger.
- `--rail` bg; Fraunces wordmark "Scry"; status dot keeps semantic mapping.
- Transcript: user/agent lines in Inter; tool/status lines in Plex Mono `--text-2xs`→`2xs`
  bumped to 12px with AA contrast; keep the left-rule log style but token-based.
- Mic: keep the amplitude "breathing" ring, recolored to petrol (live) / ink (agent
  speaking); **reduced-motion** falls back to a static ring + label.
- Surface the primary global actions here or in the canvas header (see below).

**Canvas header** — make voice actions reachable (E4, Principle 1).
- Add quiet icon+label controls for **Export**, **Undo**, **Clear** that call the exact same
  store actions the voice tools use. Everything sayable becomes clickable. Export gives visible
  feedback (E6): a toast ("Exported 42 rows to CSV") via a new lightweight toast at `--z-toast`.

**Stat cards (`StatCards.tsx`)** — typeset figures, de-templated.
- Value in Plex Mono `--data-lg`, tabular; label sentence-case `--mute` (not uppercase
  eyebrow); delta uses `--good`/`--bad` **plus** an arrow glyph (not color alone, C-series).
- Avoid the hero-metric grid cliché (B5): integrate units inline, keep to ≤4, align to the
  reading column.

**Chart (`Chart.tsx`)** — legible and described.
- Axis/label text floor **12px** (`--text-xs`), `--mute` (fixes G1/C4). Series from §3.3.
- Restrained gridlines (`--line-soft`). Highlighted series = `--accent`.
- **Text alternative** (C3): `role="img"` + `<title>` + `<desc>` summarizing what's charted
  and the top values.
- Prefer bar/line over pie when categories are many (G3) — nudge in `autoLayout`.
- Entrance animations gated behind reduced-motion.

**Comparison table (`ComparisonTable.tsx`)** — the data desk.
- Numerics in Plex Mono tabular, right-aligned; text in Inter. Hairline row rules instead of
  heavy zebra (keep a very subtle `--panel-2` on hover only).
- **Keyboard-operable sort + `aria-sort`** (C2, P0): headers become `<button>`s inside `<th>`,
  Enter/Space toggles, `aria-sort` reflects state, focus-visible ring.
- Sticky header/filter row use `--z-sticky`. Footer status keeps "showing N of M".

**Findings (`Findings.tsx`)** — editorial prose.
- Inter, `--ink`/`--mute`, comfortable line-height. Replace em-dash bullet markers with a clean
  marker (petrol tick or standard disc). Numbers bolded stay.
- **Citations** get meaningful accessible text (C7): link label like "Source 1: bayut.com"
  via `aria-label`, visible superscript unchanged.

**Sources (`SourceList.tsx`)** — reading list.
- Favicon/hostname refined; skeleton pulse recolored and **reduced-motion** aware.
- **Retry** (E3): a source in error state shows a small "Retry" button that re-runs that
  fetch; page-level `status:"error"` gets a "Try again" affordance in the banner.

---

## 6. Accessibility plan (WCAG 2.1 AA)

- **`:focus-visible`** global token ring on every interactive element (C1, P0):
  `outline: 2px solid var(--focus); outline-offset: 2px` (or ring via box-shadow where clipped).
- **Keyboard sort + `aria-sort`** on table (C2, P0).
- **Chart text alternatives** (C3).
- **Contrast**: `--dim` raised to ≥4.5:1 in both themes; min text size 11px; chart text ≥12px
  (C4/G1). Verify every token pair.
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` neutralizes rise/pulse/draw/
  ring to crossfade-or-instant (C5/F1). Reveals enhance an already-visible default (F2 fix:
  drop `both` fill so hidden-tab renders aren't stuck at opacity 0).
- **Actionable/announced controls**: example chips → buttons (C6); citation link text (C7);
  move focus to the canvas heading (or first result) when research completes (C8).

---

## 7. Motion language

Editorial restraint, state-only, 120–320ms, `--ease-out`.
- **Take-shape reveal (signature):** on results, components fade + rise `--space-2`, source
  cards stagger in as each lands (already the data-arrival model). Subtle, once, not looping.
- **State feedback:** hover/focus/active tints, filter/sort transitions, toast in/out.
- **Mic ring:** the one expressive, continuous motion — justified because it conveys live
  audio state. Static fallback under reduced-motion.
- No page-load choreography, no bounce/elastic.

---

## 8. Responsiveness

Scope: **don't break tablet; stay desktop-optimized.** (Full mobile is v2.)
- Keep the 1100px collapse (grid → single column).
- Add a `≤820px` behavior: rail collapses to a top bar (wordmark + mic + status), canvas takes
  full width, so a tablet in portrait is usable. Remove the misleading implication that phones
  are supported by documenting the boundary, or add a minimal phone fallback if time allows.

---

## 9. Architecture & migration

- **Consolidate styling into tokens** (A1–A6). Introduce the full token set first, then migrate
  each component from inline `style={}` / injected `<style>` strings to token-based classes as
  it's restyled. Target end state: `styles.css` owns tokens + shared classes; components keep
  only genuinely dynamic inline values (e.g. the `--ring` amplitude var, virtualizer offsets).
- **Preserve the zero-re-render theme switch** and first-paint `initTheme()`.
- **Kill the hardcoded `#8fb0ff`** in `DevRail.tsx` (H1) → token.

---

## 10. Rename plan (Loom → Scry) (H2)

- **User-facing (this pass):** `index.html` `<title>`, wordmark in `ChatPanel.tsx`, empty-state
  copy, `package.json` `name`, README/docs references, favicon (add one).
- **State key:** migrate `localStorage["loom:theme"]` → `"scry:theme"` with a one-time fallback
  read of the old key so existing users don't lose their setting.
- **Internal identifiers** (`loom-*` CSS classes, `loom-pulse` keyframes): optional, low
  priority; rename only if cheap. Must not break `sync-agent`/`preflight`/tests.
- **Agent prompt:** update the product name in `agent-prompt.md` / `agentConfig.ts` and re-run
  `pnpm sync-agent`; the drift test must still pass.

---

## 11. Implementation phases (build order)

Each phase ends green on `pnpm verify` (typecheck + vitest + build).

- **Phase 0 — Foundation.** Full token system in `styles.css` (color/space/type/radius/
  elevation/z/motion), Fontsource packages + stacks, focus-ring token. No visual regressions
  intended beyond palette swap.
- **Phase 1 — P0 a11y.** `:focus-visible` everywhere; keyboard-operable sort + `aria-sort`.
- **Phase 2 — Identity.** Apply Editorial palette + type to shell, rail, canvas header, cards,
  stat cards, findings, sources. Rename (§10 items) folded in here.
- **Phase 3 — Chart.** Restyle + `dataviz`-validated series + 12px text + alt text + pie nudge.
- **Phase 4 — Table.** Editorial data-desk styling on the (now keyboard-accessible) table.
- **Phase 5 — UX & motion.** Actionable prompts, first-run scaffold, retry, Export/Undo/Clear
  controls + toast, reduced-motion pass, contrast verification.
- **Phase 6 — Responsive & polish.** Tablet behavior, final polish, full a11y + contrast sweep.

Suggested commit boundary per phase on `nimras-version-ui-fixes`.

---

## 12. Testing & verification

- `pnpm verify` after each phase; keep the schema-flatness and agent-prompt-drift tests green.
- `pnpm preflight` still passes after rename (keys/agent/tools unaffected).
- Manual: keyboard-only walkthrough (tab order, focus visibility, table sort, prompt buttons);
  contrast spot-checks on both themes; reduced-motion emulation; `?demo` and `?dev` still work.
- Confirm no vendor key in `dist/` after build (existing README check).

---

## 13. Open questions / risks

1. **Fraunces character level** — Fraunces has a "wonk"/soft axis; I'll tune it toward
   restrained-editorial, not playful. Flag if you want it more classic (→ Newsreader swap is
   cheap since it's tokenized).
2. **Series palette** — provisional until `dataviz` validation (§3.3).
3. **Rail-on-tablet** — collapsing to a top bar changes the "voice is the interface" framing on
   small screens; acceptable for v1 tablet, revisit for mobile v2.
4. **Scope/time** — Phases 0–2 deliver the biggest identity+a11y win; 3–6 are incremental and
   can be triaged if the demo clock runs short.
