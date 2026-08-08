import type { UiComponentSpec } from "../../contract/ui.js";

type StatCardsSpec = Extract<UiComponentSpec, { type: "stat_cards" }>;

/**
 * Inline stat blocks — no dataset lookup, everything the agent needs is already
 * embedded in the spec (max 4 items, see contract/ui.ts).
 */
export function StatCards({ spec }: { spec: StatCardsSpec }) {
  if (!spec.items.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No stats to show.</p>;
  }

  return (
    <div className="stat-row">
      {spec.items.map((item, i) => (
        <div className="stat-item" key={`${item.label}-${i}`}>
          <div className="stat-value">{item.value}</div>
          <div className="stat-label">{item.label}</div>
          {(item.delta || item.hint) && (
            <div className="stat-meta">
              {item.delta && <span style={{ color: deltaColor(item.delta), fontWeight: 650 }}>{item.delta}</span>}
              {item.hint && <span style={{ color: "var(--dim)" }}>{item.hint}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function deltaColor(delta: string): string {
  if (delta.startsWith("+") || delta.startsWith("↑")) return "var(--good)";
  if (delta.startsWith("-") || delta.startsWith("↓")) return "var(--bad)";
  return "var(--mute)";
}
