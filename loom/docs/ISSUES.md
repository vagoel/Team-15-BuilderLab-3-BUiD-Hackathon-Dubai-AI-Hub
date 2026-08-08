# Scry — Issues & Problems Analysis

> Baseline audit of the current UI (the "Loom" codebase) as of 2026-08-08, ahead of
> the redesign. Findings are grounded in `src/styles.css`, the canvas components, the
> chat rail, and `src/lib/theme.ts`. See `DESIGN.md` for the current system and
> `docs/superpowers/specs/` for the target.

**Severity legend**
- **P0** — breaks a core promise (accessibility, trust, or a stated principle). Fix first.
- **P1** — clearly hurts polish, clarity, or identity. Core of this redesign.
- **P2** — real but lower-impact; batch into the pass.
- **v2** — out of scope now; noted for the roadmap.

---

## A. Design system / tokens

| # | Sev | Issue | Evidence |
|---|---|---|---|
| A1 | P1 | **No spacing scale.** Every padding/gap/margin is a hardcoded literal (`8/12/16/20/24/32/48/64px`), so consistency is by hand and drift is inevitable. | `styles.css` throughout; inline `style={}` in every component |
| A2 | P1 | **No type scale.** ~15 distinct font sizes (9–34px) as literals; no ratio, no tokens. Hierarchy is ad hoc. | `styles.css`; `Chart.tsx` 9px axis text; inline sizes |
| A3 | P2 | **No radius scale.** Six radii in use (`5/6/7/8/10/20px/50%`); only `--r:10px` is a token. | `styles.css`, components |
| A4 | P2 | **No elevation/shadow system.** Essentially no shadows beyond the focus ring; surfaces separate by border only, which reads flat. | `styles.css` |
| A5 | P2 | **No semantic z-index scale.** Ad-hoc `z-index:2`; no named layers (sticky/dropdown/modal/toast). | `ComparisonTable.tsx` |
| A6 | P1 | **Styling is fragmented across three mechanisms** — `styles.css`, inline `style={}` objects, and per-component injected `<style>` strings (Chart, Table, SourceList, ChatPanel). Impossible to theme or audit centrally; the same value is redefined in multiple places. | all canvas components + `ChatPanel.tsx` |

## B. Visual identity / theming

| # | Sev | Issue | Evidence |
|---|---|---|---|
| B1 | P1 | **Generic "SaaS default" look** — neutral gray surfaces + a single blue accent (`#3767d6`/`#5b8cff`). Indistinguishable from every other dashboard; hits the exact anti-reference in PRODUCT.md. Nothing ownable. | `styles.css` palette |
| B2 | P1 | **No web font / no type identity.** Pure system stack ("Inter" is only a fallback name, never loaded). A distinctive product needs a deliberate typeface, especially for data. | `styles.css` `body`; `index.html` (no font link) |
| B3 | P1 | **Light is the default, but the tool is a live-data instrument** — dark makes streaming numbers, charts, and the amplitude mic ring feel alive and reads better across a room. The strongest, most on-brand mode is not the one users land on. | `theme.ts` default `"light"` |
| B4 | P2 | **"Card title = tiny uppercase tracked eyebrow" on every card.** `.card-title` (12px, `letter-spacing:0.11em`, uppercase) on every card is the eyebrow-on-every-section tell. | `styles.css` `.card-title` |
| B5 | P2 | **Stat cards edge toward the "hero-metric template"** (big number, small uppercase label). Fine in moderation; watch that it doesn't become the page's whole personality. | `StatCards.tsx`, `.stat-*` |

## C. Accessibility (target: WCAG 2.1 AA)

| # | Sev | Issue | Evidence |
|---|---|---|---|
| C1 | **P0** | **No `:focus-visible` styling anywhere.** Keyboard focus is nearly invisible across buttons, links, chips, and controls. The only `:focus` rule is a chat-input border change. | `styles.css` (absent) |
| C2 | **P0** | **Sortable table headers are mouse-only.** `<th>` are `onClick` divs with no `role`/`tabIndex`/keyboard handler and no `aria-sort`; sorting is unreachable and unannounced for keyboard/SR users. | `ComparisonTable.tsx` |
| C3 | P1 | **Charts have no text alternative.** SVGs lack `role="img"`, `<title>`, or a summary, so all charted data is invisible to screen readers. | `Chart.tsx` |
| C4 | P1 | **`--dim` small text fails/borders AA in light mode** (`#78819a` on `#ffffff` ≈ 4.0:1), and it's used at 9–13px (chart axis, sublabels). | `styles.css`; `Chart.tsx` 9px |
| C5 | P1 | **No `prefers-reduced-motion`.** Card rise, spinner, source pulse, chart draw/grow, and the mic ring all animate with no reduced alternative. | `styles.css` + injected `<style>` |
| C6 | P1 | **Example-prompt chips look clickable but are inert `<span>`s.** Misleading affordance (also a UX bug, see E1). | `Canvas.tsx` `.chip` |
| C7 | P2 | **Citation links are bare index numbers** ("1"), poor out-of-context for screen readers. | `Findings.tsx` |
| C8 | P2 | **No focus management on session start / no skip-link.** After connecting, focus isn't moved to a useful place. | `useVoiceSession.ts`, shell |

## D. Responsiveness

| # | Sev | Issue | Evidence |
|---|---|---|---|
| D1 | P1 | **Desktop-only below 1100px.** Only two `@media(max-width:1100px)` blocks; the fixed 340px rail never collapses/hides, so on tablet/phone it eats the viewport. Fine for the demo, blocks "product later." | `styles.css` media blocks |
| D2 | P2 | **`viewport` meta exists but layout doesn't adapt** — implies mobile support that isn't there. | `index.html`, `styles.css` |

## E. UX flow / clarity

| # | Sev | Issue | Evidence |
|---|---|---|---|
| E1 | P1 | **Empty-state example prompts aren't actionable.** They read as buttons; clicking should kick off that research (or at least fill the input). Currently nothing happens. | `Canvas.tsx` `.chip` |
| E2 | P1 | **First-run isn't obvious.** New users may not know they can *type* instead of talk, what mic permission unlocks, or what to say first. The onboarding is spoken; the screen should scaffold it too. | empty state, `ChatPanel.tsx` footer |
| E3 | P1 | **No retry on failure.** `status:"error"` and per-source "couldn't read" have no visible retry/re-run affordance — the user must re-speak. | `ChatPanel.tsx` error banner, `SourceList.tsx` |
| E4 | P2 | **Voice-only actions aren't discoverable on screen.** `export`, `undo`, `clear`, filter/sort exist as tools but the canvas exposes few of them as controls, so keyboard/mouse users are second-class (tension with Principle 1: everything sayable should be reachable). | `contract/tools.ts`, canvas components |
| E5 | P2 | **Dual progress indicators** (canvas empty-state spinner + chat progress line) can read as two different things happening. | `Canvas.tsx`, `ChatPanel.tsx` |
| E6 | P2 | **Export has no obvious visible entry point / feedback** (does a file download? is there confirmation?). | `ExportDataParams`, `research/csv.ts` |

## F. Motion

| # | Sev | Issue | Evidence |
|---|---|---|---|
| F1 | P1 | **Reduced-motion unsupported** (same as C5). | as C5 |
| F2 | P2 | **`animation: rise ... both` holds `opacity:0` before start.** On a hidden tab / headless render the reveal may not fire, leaving cards blank. Reveals should enhance an already-visible default. | `styles.css` `.card` |

## G. Component-specific

| # | Sev | Issue | Evidence |
|---|---|---|---|
| G1 | P1 | **Chart axis text is 9px** — too small and, in `--dim`, below AA. | `Chart.tsx` |
| G2 | P1 | **Table is strong but dense and desktop-bound** — great on a laptop, unusable on narrow screens (ties to D1). | `ComparisonTable.tsx` |
| G3 | P2 | **Pie/donut default** can be a weaker comparison than bars for many categories; ensure autoLayout prefers the clearer form. | `autoLayout.ts`, `Chart.tsx` |

## H. Code hygiene (supporting the above)

| # | Sev | Issue | Evidence |
|---|---|---|---|
| H1 | P2 | **Hardcoded color leak** `#8fb0ff` outside the token system. | `DevRail.tsx:211` |
| H2 | P1 | **Rename debt.** Product is "Scry" but code/wordmark/`<title>`/`package.json`/`localStorage["loom:theme"]`/`loom-*` classes still say "Loom". | `index.html`, `ChatPanel.tsx`, `theme.ts`, `package.json` |

---

## Priority summary

- **Do first (P0):** C1 focus-visible, C2 keyboard-sortable headers. These break the accessibility promise outright.
- **Core of the redesign (P1):** the token system (A1/A2/A6), a real visual identity + typeface + dark-first theme (B1/B2/B3), remaining AA fixes (C3–C6), responsiveness (D1), and the UX-clarity set (E1–E3). This is where "polished, clear, distinctive" is won — and, per your framing, where the wow-factor comes from as a byproduct.
- **Batch in (P2):** radius/shadow/z-index scales, eyebrow overuse, dual-progress, discoverability of voice-only actions, chip/citation/dev-leak details, rename debt.
- **Roadmap (v2):** per-cell provenance, persistence, mobile-first rework, more component types (map/timeline) — already captured in TECH-SPEC §05.
