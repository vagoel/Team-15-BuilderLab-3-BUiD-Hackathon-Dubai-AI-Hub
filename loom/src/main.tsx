import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./lib/theme.js";
// Self-hosted fonts (no CDN request; CSP-safe). Fraunces carries display/headings
// with optical sizing, Inter the UI/body, IBM Plex Mono the tabular data.
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

// Before the first paint, so the app never flashes the wrong palette.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
