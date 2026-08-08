import { useState } from "react";
import type { Dataset, Source } from "../../contract/dataset.js";

const DOT_COLORS = ["#5b8cff", "#00d3a7", "#ffb454", "#ff6b6b", "#c792ea", "#4fd1c5"] as const;

export function SourceList({ dataset }: { dataset: Dataset | undefined }) {
  const sources = dataset?.sources ?? [];

  if (!sources.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No sources yet.</p>;
  }

  return (
    <div>
      <style>{`
        .loom-src-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
        .loom-src-row:last-child { border-bottom: none; }
        .loom-src-skel { animation: loom-pulse 1.4s ease-in-out infinite; }
        @keyframes loom-pulse { 0%, 100% { opacity: .4; } 50% { opacity: .95; } }
        .loom-src-link { color: var(--ink); text-decoration: none; font-size: 13px; font-weight: 550; }
        .loom-src-link:hover { color: var(--accent); text-decoration: underline; }
      `}</style>
      {sources.map((s) => (
        <SourceRow key={s.id} source={s} />
      ))}
    </div>
  );
}

function SourceRow({ source }: { source: Source }) {
  const pending = !source.fetchedAt && !source.error;
  const host = hostname(source.url);

  return (
    <div className={"loom-src-row" + (pending ? " loom-src-skel" : "")}>
      <Avatar source={source} />
      <div style={{ minWidth: 0, flex: 1 }}>
        {source.url ? (
          <a className="loom-src-link" href={source.url} target="_blank" rel="noreferrer">
            {source.title || host || source.url}
          </a>
        ) : (
          <span className="loom-src-link">{source.title || "Untitled source"}</span>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: "var(--dim)",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {source.error ? <span style={{ color: "var(--bad)" }}>couldn&apos;t read</span> : host}
        </div>
      </div>
    </div>
  );
}

function Avatar({ source }: { source: Source }) {
  const [broken, setBroken] = useState(false);
  const logo = source.brand?.logoUrl;

  if (logo && !broken) {
    return (
      <img
        src={logo}
        alt=""
        width={20}
        height={20}
        style={{ borderRadius: 5, flex: "none", objectFit: "cover", background: "var(--panel-2)" }}
        onError={() => setBroken(true)}
      />
    );
  }

  const color = source.brand?.color || dotColor(source.id || source.url);
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} />;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function dotColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return DOT_COLORS[hash % DOT_COLORS.length] ?? DOT_COLORS[0];
}
