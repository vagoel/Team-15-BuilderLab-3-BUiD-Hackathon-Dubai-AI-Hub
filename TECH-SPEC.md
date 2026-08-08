# Loom Technical Specification

## 01. Problem

Web research through chat usually ends as prose: facts are mixed into a long answer, comparisons are hard to scan, and every follow-up requires another prompt. This is worse over voice because reading rows, prices, and citations aloud is slow and difficult to retain.

Loom is for people who want to compare current information from several web pages and manipulate the result hands-free. A user asks a question by voice or text; Loom reads selected URLs, extracts consistent fields, and builds a dashboard with the underlying rows and sources. Commands such as “filter above 50,” “sort by price,” “show only the chart,” and “export this” operate on that dashboard. Voice keeps the interaction conversational while the canvas carries information that speech handles poorly.

The implemented product is an on-demand browser research tool, not a general crawler. It does not continuously monitor the web or run an autonomous background loop.

## 02. Architecture

```text
User voice/text
      |
      v
ElevenLabs managed conversation
      | client tool call
      v
Browser tool handler -- validates with Zod
      |
      +-- research --> Vite proxy --> context.dev
      |                   adds secret auth header
      |                         |
      |<-- structured result ---+
      |
      +-- full dataset --> Zustand store --> React canvas
      |
      +-- compact summary + dataset ID --> ElevenLabs
```

ElevenLabs owns microphone transport, transcription, speech, turn-taking, and tool selection. Every Loom tool is declared from the same Zod contract used by its browser handler. A research call includes the question, seed URLs selected by the agent, and the field schema it designed.

The browser calls same-origin `/api/context/*` routes. Vite proxies them to context.dev and injects `CONTEXT_DEV_API_KEY` on the Node side. Source requests run concurrently with `Promise.allSettled`; hooks update source and progress state as each request settles. This is incremental browser-state update, not response streaming or SSE.

The full dataset remains in Zustand. ElevenLabs receives only a dataset ID, counts, headline, fields, and short findings. `autoLayout` reads the stored rows and selects from five implemented component types: stat cards, chart, comparison table, findings, and source list. Follow-up tools mutate the same state the React components read, while `get_ui_state` lets the agent inspect the visible structure. `export_report` builds a print-specific view from that browser state: semantic HTML tables replace virtualized screen tables, SVG charts remain vectors, and native browser printing produces a PDF without a backend or persisted report copy. `export_data` remains the separate CSV path for raw rows.

There is no production backend or persistence. A refresh clears the session, and the development proxy must be replaced before public deployment.

## 03. Tool rationale

### ElevenLabs

ElevenLabs supplies the managed browser conversation: microphone handling, WebRTC voice transport, speech output, turn-taking, transcripts, and client-tool calls. Building separate speech-to-text, text-to-speech, interruption, and audio-session layers would consume the hackathon window without improving research. Client tools also let the conversation operate local UI state without sending every row through the model. Because ElevenLabs supports a restricted JSON Schema subset, Loom keeps tool parameters flat and generates declarations from Zod.

### context.dev

context.dev accepts a caller-supplied JSON Schema and returns structured records from a URL. That matches Loom’s division of work: the agent decides which fields answer the question, and context.dev fills them from current pages. Loom also uses markdown scraping as a guarded fallback and brand retrieval for source metadata. Site-specific scrapers would not fit the time limit and would depend on fragile selectors. The API key remains behind the proxy.

### Devin

Devin was used for implementation leverage after the contract and module boundaries were fixed. Canvas rendering, research, and voice integration could be developed as separate workstreams against stable schemas, then checked through integration tests. Devin is a build-time engineering tool only; it is not imported by Loom or involved in runtime agent behavior.

## 04. Feasibility

The six-hour scope was protected by fixing one non-negotiable path: **question -> live extraction -> automatic dashboard -> spoken UI change**. The implementation stays feasible by using:

- one Vite/React application rather than separate application servers;
- a managed ElevenLabs conversation rather than custom audio infrastructure;
- context.dev schema extraction rather than per-site scrapers;
- five known UI components instead of arbitrary generated markup;
- deterministic `autoLayout` instead of model-authored UI specifications;
- browser-only Zustand state with no accounts, database, or collaboration;
- concurrent requests, a warm session cache, and mock datasets for fast UI work;
- one shared contract so independent workstreams do not redefine interfaces; and
- `preflight` checks for keys, quotas, agent configuration, and live API access.

Scope stops at browser-only sessions, five component types, and request-time research. The current code deliberately omits a timeline, monitoring, proactive background speech, a production API, authentication, and persistence.

## 05. Extensibility

A v2 would keep the typed contract and add:

1. **A production API boundary** for context.dev, with authentication, URL controls, rate limits, request validation, and server-side caching.
2. **Persistent sessions** for datasets, source snapshots, dashboard layouts, sharing, and reopening prior research.
3. **Source discovery and refresh jobs** before extraction. Monitoring would be a new server feature, not a relabeling of the current request-time pipeline.
4. **Field-level provenance** with source links, extraction times, confidence, and error metadata for every displayed value.
5. **More bounded components**, such as maps and timelines, without allowing arbitrary executable markup.
6. **Multi-user controls** for accounts, encrypted secrets, quotas, observability, and vendor-outage recovery.

The central constraint remains: models state research and presentation intent, services fetch data, and deterministic application code owns the rows and rendered interface.
