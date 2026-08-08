# Loom

**Voice-driven web research that builds an interactive dashboard while you talk.**

Ask Loom a research question by voice or text. Its ElevenLabs conversational agent chooses the sources and the fields to extract, context.dev reads those live pages into structured rows, and the React app turns the result into stat cards, a chart, a filterable table, findings, and a source list. Follow-up commands such as “hide anything over AED 2 million,” “sort by price,” or “export this” operate on the dashboard already on screen.

The bulk dataset stays in the browser rather than passing through the language model. The agent receives a compact summary and dataset ID, while the canvas reads the rows directly from the Zustand store.

## What it does

- Accepts spoken or typed research questions through an ElevenLabs conversational session.
- Extracts an agent-defined schema from one or more live URLs with context.dev.
- Fetches sources in parallel and updates source/progress state as each request completes.
- Automatically lays out five guarded component types: stat cards, charts, comparison tables, findings, and sources.
- Lets the agent filter, sort, highlight, focus, move, add, remove, clear, undo, and export dashboard data through typed client tools.
- Includes local mock datasets and a developer rail so the UI can be demonstrated without API credits.

## Prerequisites

On a clean machine, install:

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 22 LTS or newer
- [pnpm](https://pnpm.io/installation) (the verified setup uses 11.20.0)
- A Chromium-based browser with microphone access
- An [ElevenLabs](https://elevenlabs.io/) account and API key
- A [context.dev](https://context.dev/) account and API key

If pnpm is not already available, install it with npm:

```bash
npm install --global pnpm@11.20.0
```

## Install and configure

1. Clone the repository and install the app dependencies:

   ```bash
   git clone https://github.com/vagoel/Team-15-BuilderLab-3-BUiD-Hackathon-Dubai-AI-Hub.git
   cd Team-15-BuilderLab-3-BUiD-Hackathon-Dubai-AI-Hub/loom
   pnpm install --frozen-lockfile
   ```

2. Create `.env` in the repository root, one level above `loom/`:

   ```dotenv
   ELEVEN_LABS_API_KEY=your_elevenlabs_api_key
   CONTEXT_DEV_API_KEY=your_context_dev_api_key
   ```

   `ELEVEN_LABS_API_KEY` is used only by the Node-side setup and preflight scripts. `CONTEXT_DEV_API_KEY` stays in the Vite development server and is injected by its same-origin proxy; it is not bundled into browser code.

3. Create or update the ElevenLabs agent from the checked-in prompt and typed tool contract:

   ```bash
   pnpm sync-agent
   ```

   On a new ElevenLabs account, this creates the agent and prints an `ELEVENLABS_AGENT_ID=...` line. Add that line to the same root `.env` file, then restart the dev server whenever the ID changes. The agent ID is public; it is the two API keys that must remain secret.

4. Confirm that the credentials, quotas, public agent, attached tools, and both context.dev endpoints are ready:

   ```bash
   pnpm preflight
   ```

   This command makes live vendor requests and consumes a small amount of context.dev quota. Use `pnpm preflight --deep` only when you also want the five-page extraction latency check.

## Run

From `loom/`:

```bash
pnpm dev
```

Open <http://localhost:5173>, press **Start**, allow microphone access, and ask a research question. The agent supplies the URLs it wants Loom to read, so live research requires internet access and usable vendor quota.

Useful local modes:

- <http://localhost:5173/?demo> opens a populated mock dashboard without a research request.
- <http://localhost:5173/?dev> opens the developer rail for exercising UI tools directly.

## Architecture

```text
Microphone or text -> ElevenLabs agent -> browser tool handlers
                                            |
                         +------------------+------------------+
                         |                                     |
                         v                                     v
              Vite /api/context proxy                    Zustand store
                 adds secret header                           |
                         |                                     v
                         v                                React canvas
                    context.dev

Browser handlers return only a compact summary and dataset ID to ElevenLabs.
```

ElevenLabs owns speech, turn-taking, and tool selection. Browser-side handlers validate every tool call with the shared Zod contract. Research calls go through the local Vite proxy to context.dev, then write structured datasets into Zustand. The canvas derives a safe layout from that state instead of asking the model to generate arbitrary UI. Source requests run in parallel and update browser state as they finish; there is no application backend, SSE channel, autonomous background monitor, or separate custom agent loop.

## Project layout

| Path | Purpose |
|---|---|
| `loom/src/contract/` | Shared Zod schemas for datasets, UI specs, and agent tools |
| `loom/src/voice/` | ElevenLabs session lifecycle, prompt/config generation, and tool handlers |
| `loom/src/research/` | context.dev client, cache, extraction pipeline, and fallbacks |
| `loom/src/canvas/` | Automatic layout and the five dashboard component types |
| `loom/src/store.ts` | Zustand state shared by voice tools and the visible UI |
| `loom/mock/` | Local mock API and prepared/generated datasets |
| `loom/scripts/` | ElevenLabs sync and live preflight checks |

## Verify the build

```bash
cd loom
pnpm verify
```

`pnpm verify` runs TypeScript checking, the Vitest suite, and a production Vite build. To confirm that vendor secrets were not emitted into the bundle, inspect `loom/dist/` after the build; only the public ElevenLabs agent ID is intentionally compiled into client code.

## Documentation

- [`TECH-SPEC.md`](TECH-SPEC.md) — problem, architecture, tool choices, six-hour scope, and v2.
- [`loom/BUILDING.md`](loom/BUILDING.md) — implementation decisions and lessons from the build.
- [`loom/PLAN.md`](loom/PLAN.md) — original build order, cut list, and risks.
- [`loom/README.md`](loom/README.md) — deeper implementation and tool reference.

## Current deployment boundary

The included context.dev proxy is a development-only Vite proxy. Do not deploy this static bundle by exposing `CONTEXT_DEV_API_KEY` to the browser. A public deployment needs a small server or edge function that owns the key, validates allowed requests, and forwards the context.dev calls.
