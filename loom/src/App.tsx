import { useEffect, useState } from "react";
import { Canvas } from "./canvas/Canvas.js";
import { ChatPanel } from "./chat/ChatPanel.js";
import { DevRail } from "./dev/DevRail.js";
import { useLoom } from "./store.js";
import { createToolHandlers } from "./voice/toolHandlers.js";

/**
 * App-in-app: a narrow conversation rail on the left, and the research canvas —
 * the actual product — taking the rest. The canvas is what the agent builds.
 *
 * The dev rail swaps in for the chat rail and drives the same store actions by
 * button, so the canvas can be worked on without spending a research call. Open it
 * with the toggle, or by loading `?dev`.
 */
export function App() {
  const [dev, setDev] = useState(() => new URLSearchParams(location.search).has("dev"));
  useDemoDashboard();

  return (
    <div className="app">
      {dev ? <DevRail onClose={() => setDev(false)} /> : <ChatPanel />}
      <Canvas />
      {!dev && (
        <button onClick={() => setDev(true)} style={toggle} title="Open the dev harness">
          dev
        </button>
      )}
    </div>
  );
}

/**
 * `?demo` boots straight into a populated dashboard, so the voice flow can be
 * exercised without spending a research call first. `?demo=models` picks a table;
 * anything the mock API serves works. The plain product still opens empty.
 */
function useDemoDashboard() {
  useEffect(() => {
    const table = new URLSearchParams(location.search).get("demo");
    if (table === null) return;
    if (useLoom.getState().spec) return;

    void createToolHandlers().mock_data?.({ table: table || "sales", rows: 120 });
  }, []);
}

const toggle: React.CSSProperties = {
  position: "fixed",
  right: 14,
  bottom: 12,
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: "var(--dim)",
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  padding: "5px 9px",
  opacity: 0.55,
};
