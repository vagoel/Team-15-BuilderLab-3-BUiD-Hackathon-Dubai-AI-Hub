import type { ReactNode } from "react";
import type { UiComponentSpec } from "../../contract/ui.js";
import type { Dataset, Finding } from "../../contract/dataset.js";

type FindingsSpec = Extract<UiComponentSpec, { type: "findings" }>;

export function Findings({ spec, dataset }: { spec: FindingsSpec; dataset: Dataset | undefined }) {
  const items: Finding[] = spec.items ?? dataset?.findings ?? [];

  if (!items.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No findings yet.</p>;
  }

  const sources = dataset?.sources ?? [];
  const indexOf = new Map(sources.map((s, i) => [s.id, i + 1] as const));

  return (
    <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((f, i) => (
        <li key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span aria-hidden style={{ color: "var(--accent)", flex: "none", fontSize: "var(--text-sm)" }}>•</span>
          <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.55, color: "var(--mute)" }}>
            {highlightNumbers(f.text)}
            {f.sourceIds.length > 0 && (
              <span style={{ marginLeft: 6 }}>
                {f.sourceIds.map((sid, si) => {
                  const idx = indexOf.get(sid);
                  if (!idx) return null;
                  const source = sources.find((s) => s.id === sid);
                  return (
                    <a
                      key={si}
                      href={source?.url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      title={source?.title}
                      aria-label={`Source ${idx}${source?.title ? `: ${source.title}` : ""} (opens in new tab)`}
                      style={{
                        fontSize: 10,
                        verticalAlign: "super",
                        color: "var(--accent)",
                        marginLeft: 3,
                        textDecoration: "none",
                        fontWeight: 700,
                      }}
                    >
                      {idx}
                    </a>
                  );
                })}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Wraps numeric tokens (currency, percentages, plain numbers) in the ink colour. */
function highlightNumbers(text: string): ReactNode[] {
  const regex = /(\$?\d[\d,]*(?:\.\d+)?%?)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }
    parts.push(
      <span key={key++} style={{ color: "var(--ink)", fontWeight: 600 }}>
        {token}
      </span>,
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }
  return parts;
}
