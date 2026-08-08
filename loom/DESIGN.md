# Design

> Captures the **current** visual system as built (as of 2026-08-08). This is the
> baseline the redesign works from — see `docs/superpowers/specs/` for the target.
> Once the redesign lands, this file should be updated to describe the new system.

## Overview

Scry (named "Loom" in the code today; rename pending) is a two-pane desktop app: a **340px conversation rail** (left) and a **research canvas** (right, the product). One hand-authored design-token system in a single stylesheet drives two complete themes (light + dark) with a zero-re-render switch. No UI framework, no component library, no Tailwind; charts are hand-rolled SVG. Styling is split across `src/styles.css` (global tokens + shell), inline `style={}` objects, and per-component injected `<style>` strings.

- **Framework:** Vite 6 + React 19 + TypeScript. State in Zustand; contracts in Zod.
- **Entry:** `index.html` → `src/main.tsx` (calls `initTheme()` before first paint to avoid a flash) → `src/App.tsx`.
- **Theme mechanism:** `src/lib/theme.ts` — modes `light | dark | system`, persisted to `localStorage["loom:theme"]` (default `light`). `system` removes `data-theme` so the media query stays authoritative.

## Theme / Color

All color is a CSS custom property on `:root`. **Light is the base**; dark is duplicated across `:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`. Chart series read tokens directly, so charts re-color on theme switch with no JS.

### Light (`:root`, `:root[data-theme="light"]`)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f6f7f9` | app background |
| `--panel` | `#ffffff` | card / rail surface |
| `--panel-2` | `#f0f2f7` | secondary surface (primary cards, zebra rows) |
| `--line` | `#dde1e9` | borders |
| `--line-soft` | `#e9ecf2` | quiet borders |
| `--ink` | `#10131c` | primary text |
| `--mute` | `#525a70` | secondary text (~7:1 on white, OK) |
| `--dim` | `#78819a` | tertiary text (~4.0:1 on white — borderline) |
| `--accent` | `#3767d6` | primary action / selection |
| `--accent-soft` | `rgba(55,103,214,0.13)` | hover / focus tint |
| `--good` / `--warn` / `--bad` | `#00846b` / `#a76a09` / `#ce3b3b` | semantic |
| `--scroll-thumb` | `#cbd1dd` | scrollbar |
| `--series-1..8` | `#3767d6 #00846b #b3700a #d04747 #7c53d8 #0d8ba8 #cf3f86 #9a7b06` | chart series (darkened for light bg) |

### Dark (`:root[data-theme="dark"]` + media block)

| Token | Value |
|---|---|
| `--bg` | `#07080c` |
| `--panel` | `#0e1017` |
| `--panel-2` | `#141822` |
| `--line` | `#202634` |
| `--line-soft` | `#191e29` |
| `--ink` | `#eef1f7` |
| `--mute` | `#98a2b8` |
| `--dim` | `#656e83` |
| `--accent` | `#5b8cff` |
| `--accent-soft` | `rgba(91,140,255,0.14)` |
| `--good` / `--warn` / `--bad` | `#00d3a7` / `#ffb454` / `#ff6b6b` |
| `--series-1..8` | `#5b8cff #00d3a7 #ffb454 #ff6b6b #a78bfa #22d3ee #f472b6 #facc15` |

**Strategy:** Restrained — tinted neutrals + a single blue accent used for actions, selection, and state. Color is otherwise carried by the chart series.

**Known leak:** one hardcoded `#8fb0ff` in `src/dev/DevRail.tsx:211` (dev-only).

## Typography

- **Family:** system stack — `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif`. **No web font is loaded** ("Inter" is only a fallback name). Monospace stack used for tool/status log lines and dev labels.
- **Base:** `15px`, `-webkit-font-smoothing: antialiased`. `font-variant-numeric: tabular-nums` on stat values and numeric cells.
- **Scale (as used, all hardcoded literals):** stat value `34px/750`, empty-state h2 `30px/750`, canvas title `19px/700`, body `13–15px`, card-title `12px` uppercase `0.11em`, stat-label/small `11px` uppercase, tool/status log `11.5px` mono, chart axis text `9px`. ~15 distinct sizes in play; **no type scale tokens**.

## Spacing, Radius, Shadow, Z-index

- **Only two non-color tokens exist:** `--r: 10px` (card radius) and `--chat-w: 340px`.
- **No spacing scale** — paddings/gaps (`8/12/16/20/24/32/48/64px`) are literals throughout.
- **Radii in use:** `5 / 6 / 7 / 8 / 10 / 20px / 50%` — no radius scale.
- **Shadows:** essentially none beyond the focus ring `box-shadow: 0 0 0 3px var(--accent-soft)`.
- **Z-index:** ad hoc (`z-index: 2` on sticky table header); no semantic scale.

## Layout

- **Shell:** `.app { display:grid; grid-template-columns: var(--chat-w) 1fr; height:100% }`. `body { overflow:hidden }`; only the rail's scroll region and `.canvas` scroll internally.
- **Canvas:** `padding: 32px 32px 64px; max-width: 1600px; margin: 0 auto`. Content is a 12-col grid (`repeat(12,1fr)`, `gap:16px`) or a vertical stack.
- **Component spans** (`autoLayout` / `Canvas.tsx`): stat_cards `12`, chart `5`, table `7` (or `12` if no chart), findings `8`, source_list `4`.
- **Card weights:** `.card-primary` (`--panel-2` bg) for chart/table; `.card-quiet` (16px pad, softer border) for sources/findings.
- **Responsive:** desktop-first, effectively **desktop-only**. Two `@media (max-width:1100px)` blocks collapse the grid to one column and tighten padding. No breakpoint below 1100px; the 340px rail never collapses. Not mobile-viable.

## Components

Five renderable canvas components (discriminated union via `registry.tsx`):

- **Chart** (`Chart.tsx`) — hand-built SVG (`viewBox 0 0 600 260`). Bar (grouped, rounded tops), line (polyline + dots), pie (donut with leader labels). "Nice" axis max, compact `k/M` formatting, auto-aggregation to mean-per-category, caps (12 groups / 8 pie slices), label rotation past 8 categories. Capped to `max-height:288px`.
- **ComparisonTable** (`ComparisonTable.tsx`, ~542 lines) — headless TanStack Table v9 + Virtual (row 34px, overscan 10, max-height 420px). Sticky header + sticky filter row, column resize, tri-state sort, zebra striping, hover tint, highlight rows with a leading accent border. Two filter layers (voice `spec.filters` + per-column header inputs, debounced 150ms). Footer status: "showing N of M rows".
- **StatCards** (`StatCards.tsx`) — `.stat-row` auto-fit grid; big tabular value + uppercase label + optional colored delta. Max 4 items.
- **SourceList** (`SourceList.tsx`) — favicon/logo avatar (falls back to a hashed color dot), title link + hostname. **Pending sources pulse** (skeleton); errors show "couldn't read".
- **Findings** (`Findings.tsx`) — bulleted list, numbers bolded via regex, superscript numbered source citations.

Each canvas component is wrapped in a `.card` `<section>` with a per-card React **error boundary** (`CardBoundary` → "Couldn't render {type}").

**Chat rail** (`ChatPanel.tsx`): header (wordmark + theme toggle + status dot), transcript (user right / agent left / tool+status as monospace log lines with a left border), footer (text input + Send, then the mic). **Mic button** (52px circle) has an amplitude-reactive "breathing" ring driven by a `--ring` CSS var (green live, blue while the agent speaks) — the standout micro-interaction.

## States

Genuinely handled (a strength): idle empty state (h2 + example-prompt chips), research-loading (spinner + progress label + `done/total`), per-source skeleton pulse, per-component empty text, per-card error boundary, and a `role="alert"` chat error banner. Gaps: example chips look clickable but are inert `<span>`s; no retry affordances; no full-page error boundary.

## Motion

Defined in `styles.css` and injected `<style>` blocks: `rise` (cards fade + translateY 8px, 0.32s), `spin` (0.7s), `loom-pulse` (source skeleton 1.4s), chart entrances (`loom-bar-grow` staggered, `loom-line-draw` stroke-dashoffset, `loom-dot-in`, `loom-slice-in`), transitions 0.15–0.25s, and the amplitude-reactive mic ring. **No `prefers-reduced-motion` alternative anywhere.**

## Accessibility (current)

Present: semantic landmarks (`main`/`aside`/`header`/`section`/real `<table>`), `role="alert"` on errors, `aria-label` on mic/theme buttons, `alt=""` on decorative logos, `rel="noreferrer"`, `color-scheme` set. **Gaps:** no `:focus-visible` styling anywhere; sortable `<th>` are click-only divs with no `role`/`tabIndex`/`aria-sort`; chart SVGs have no `role="img"`/`<title>`/text alternative; citation links are bare index numbers; `--dim` small text at/below AA in light mode; no `prefers-reduced-motion`.
