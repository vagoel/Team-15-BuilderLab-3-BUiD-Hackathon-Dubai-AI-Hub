import { useState } from "react";
import { useLoom } from "../store.js";
import { useTemplates } from "./templateStore.js";

/**
 * The far-left rail: saved report layouts.
 *
 * Collapsed by default and narrow when open, because it is the least-used surface in
 * the app and the canvas is the product. Selection locks while a voice session is
 * live — the session pinned a template at startup and told the agent about it, so
 * letting the user swap now would leave the agent describing a layout the canvas is
 * not using.
 */
export function TemplateRail() {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const spec = useLoom((s) => s.spec);
  const status = useLoom((s) => s.status);
  const templates = useTemplates((s) => s.templates);
  const selectedId = useTemplates((s) => s.selectedId);
  const pinned = useTemplates((s) => s.pinnedTemplate);
  const { saveCurrentReport, select, rename, remove } = useTemplates.getState();

  // "Connecting" counts as locked too: the session is already being started with
  // whatever was selected a moment ago.
  const locked = pinned !== null || status === "connecting";

  function save() {
    try {
      saveCurrentReport(spec, draftName);
      setNaming(false);
      setDraftName("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!open) {
    return (
      <aside className="rail rail--collapsed">
        <button className="rail-toggle" onClick={() => setOpen(true)} title="Report templates" aria-label="Open report templates">
          <LayoutIcon />
        </button>
        {selectedId && <span className="rail-dot" title="A template is selected" />}
      </aside>
    );
  }

  return (
    <aside className="rail">
      <style>{railStyles}</style>
      <header className="rail-head">
        <span className="rail-word">Templates</span>
        <button className="rail-toggle" onClick={() => setOpen(false)} aria-label="Collapse templates">
          ‹
        </button>
      </header>

      <div className="rail-body scroll">
        <button
          className={`rail-item${selectedId === null ? " rail-item--on" : ""}`}
          onClick={() => select(null)}
          disabled={locked}
        >
          <span className="rail-item-name">Adaptive</span>
          <span className="rail-item-hint">Loom picks the layout</span>
        </button>

        {templates.map((template) => (
          <div key={template.id} className={`rail-item${selectedId === template.id ? " rail-item--on" : ""}`}>
            <button className="rail-item-main" onClick={() => select(template.id)} disabled={locked}>
              <span className="rail-item-name">{template.name}</span>
              <span className="rail-item-hint">
                {template.slots.length} slot{template.slots.length === 1 ? "" : "s"}
              </span>
            </button>
            <div className="rail-item-actions">
              <button
                onClick={() => {
                  const next = prompt("Rename template", template.name);
                  if (next) rename(template.id, next);
                }}
                title="Rename"
                aria-label={`Rename ${template.name}`}
              >
                ✎
              </button>
              <button onClick={() => remove(template.id)} title="Delete" aria-label={`Delete ${template.name}`}>
                ×
              </button>
            </div>
          </div>
        ))}

        {templates.length === 0 && <p className="rail-empty">Save a report to reuse its layout later.</p>}
      </div>

      <footer className="rail-foot">
        {locked && <p className="rail-note">Selection is locked until this session ends.</p>}
        {error && <p className="rail-error">{error}</p>}

        {naming ? (
          <div className="rail-save">
            <input
              autoFocus
              value={draftName}
              placeholder="Template name"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setNaming(false);
              }}
            />
            <button onClick={save}>Save</button>
          </div>
        ) : (
          spec && (
            <button className="rail-save-open" onClick={() => setNaming(true)}>
              Save current report
            </button>
          )
        )}
      </footer>
    </aside>
  );
}

function LayoutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}

const railStyles = `
.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.rail-word { font-weight: 800; font-size: 13px; letter-spacing: -0.01em; }
.rail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.rail-item {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: left;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--panel-2);
  padding: 8px 10px;
  gap: 6px;
}
.rail-item--on { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.rail-item-main { flex: 1; min-width: 0; text-align: left; }
.rail-item-name { display: block; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-item-hint { display: block; font-size: 11px; color: var(--dim); margin-top: 2px; }
.rail-item-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.rail-item:hover .rail-item-actions { opacity: 1; }
.rail-item-actions button { color: var(--dim); font-size: 13px; padding: 2px 5px; border-radius: 5px; }
.rail-item-actions button:hover { color: var(--ink); background: var(--panel); }
.rail-item:disabled, .rail-item-main:disabled { opacity: 0.5; cursor: not-allowed; }
.rail-empty { font-size: 12px; color: var(--dim); padding: 8px 4px; line-height: 1.5; }
.rail-foot { flex: none; padding: 10px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.rail-note { font-size: 11px; color: var(--dim); line-height: 1.4; }
.rail-error { font-size: 11px; color: var(--bad); line-height: 1.4; }
.rail-save { display: flex; gap: 6px; }
.rail-save input {
  flex: 1; min-width: 0; font: inherit; font-size: 12px; color: var(--ink);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px;
}
.rail-save button, .rail-save-open {
  font-size: 12px; font-weight: 600; color: var(--ink);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 6px 10px;
}
.rail-save-open { width: 100%; }
.rail-save-open:hover { border-color: var(--accent); }
`;
