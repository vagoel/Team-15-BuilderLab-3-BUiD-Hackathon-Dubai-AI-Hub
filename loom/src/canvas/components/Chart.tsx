import type { UiComponentSpec } from "../../contract/ui.js";
import type { Dataset, DataRecord } from "../../contract/dataset.js";
import { applyFilters } from "../../lib/filter.js";

type ChartSpec = Extract<UiComponentSpec, { type: "chart" }>;

const COLORS = [
  "#5b8cff",
  "#00d3a7",
  "#ffb454",
  "#ff6b6b",
  "#a78bfa",
  "#22d3ee",
  "#f472b6",
  "#facc15",
] as const;
const WIDTH = 600;
const HEIGHT = 260;
const MARGIN = { top: 16, right: 16, bottom: 34, left: 48 };
const GRID_FRACTIONS = [0.25, 0.5, 0.75, 1];
const EMPTY_MESSAGE = "No rows match the current filter.";
const CHART_GROUP_CAP = 12;

export function Chart({ spec, dataset }: { spec: ChartSpec; dataset: Dataset | undefined }) {
  if (!dataset) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No data yet.</p>;
  }

  const rows = applyFilters(dataset.records, spec.filters);
  if (!rows.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>{EMPTY_MESSAGE}</p>;
  }

  const fieldLabel = (key: string) => dataset.fields.find((f) => f.key === key)?.label ?? key;

  if (spec.kind === "pie") {
    return <PieChart rows={rows} xKey={spec.x} yKey={spec.y[0]} />;
  }

  const xValues = rows.map((r) => String(r[spec.x] ?? ""));
  const distinctXCount = new Set(xValues).size;
  const shouldAggregate = rows.length !== distinctXCount;

  let categories: string[];
  let series: { key: string; label: string; values: number[] }[];
  let caption: string | undefined;

  if (shouldAggregate) {
    const aggregated = aggregateByCategory(rows, spec, fieldLabel);
    categories = aggregated.categories;
    series = aggregated.series;
    caption = aggregated.caption;
  } else {
    categories = xValues;
    series = spec.y.map((key) => ({
      key,
      label: fieldLabel(key),
      values: rows.map((r) => toNumber(r[key])),
    }));
    caption = undefined;
  }

  if (!categories.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>{EMPTY_MESSAGE}</p>;
  }

  const rawMax = Math.max(0, ...series.flatMap((s) => s.values));
  const domainMax = niceMax(rawMax);

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const bandWidth = plotW / categories.length;
  const rotateLabels = categories.length > 8;

  return (
    <div>
      {caption && (
        <div style={{ color: "var(--dim)", fontSize: 12, marginBottom: 8 }}>{caption}</div>
      )}
      {series.length > 1 && (
        <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
          {series.map((s, i) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--mute)" }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: colorAt(i),
                  display: "inline-block",
                  flex: "none",
                }}
              />
              {s.label}
            </div>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
      >
        <style>{`
          .loom-bar { animation: loom-bar-grow .45s ease both; transform-box: fill-box; transform-origin: bottom; }
          @keyframes loom-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
          .loom-line { stroke-dasharray: 1400; stroke-dashoffset: 1400; animation: loom-line-draw .7s ease forwards; }
          @keyframes loom-line-draw { to { stroke-dashoffset: 0; } }
          .loom-dot { animation: loom-dot-in .3s ease both; }
          @keyframes loom-dot-in { from { opacity: 0; } to { opacity: 1; } }
        `}</style>

        {GRID_FRACTIONS.map((f) => {
          const y = MARGIN.top + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y} y2={y} stroke="var(--line-soft)" strokeWidth={1} />
              <text x={MARGIN.left - 8} y={y + 3} textAnchor="end" fontSize={9} fill="var(--dim)">
                {formatCompact(f * domainMax)}
              </text>
            </g>
          );
        })}
        <line
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={MARGIN.top + plotH}
          y2={MARGIN.top + plotH}
          stroke="var(--line)"
          strokeWidth={1}
        />

        {spec.kind === "bar" ? (
          <g>
            {categories.map((_, ci) => {
              const groupX = MARGIN.left + ci * bandWidth;
              const groupPad = bandWidth * 0.14;
              const groupW = bandWidth - groupPad * 2;
              const barW = groupW / series.length;
              return (
                <g key={ci}>
                  {series.map((s, si) => {
                    const value = s.values[ci] ?? 0;
                    const h = domainMax > 0 ? (value / domainMax) * plotH : 0;
                    const x = groupX + groupPad + si * barW;
                    const y = MARGIN.top + plotH - h;
                    return (
                      <path
                        key={s.key}
                        className="loom-bar"
                        style={{ animationDelay: `${ci * 30 + si * 15}ms` }}
                        d={roundedTopRectPath(x + 1, y, Math.max(barW - 2, 1), h, 3)}
                        fill={colorAt(si)}
                      />
                    );
                  })}
                </g>
              );
            })}
          </g>
        ) : (
          <g>
            {series.map((s, si) => {
              const points = s.values
                .map((v, i) => {
                  const x = MARGIN.left + i * bandWidth + bandWidth / 2;
                  const h = domainMax > 0 ? (v / domainMax) * plotH : 0;
                  const y = MARGIN.top + plotH - h;
                  return `${x},${y}`;
                })
                .join(" ");
              return (
                <g key={s.key}>
                  <polyline className="loom-line" points={points} fill="none" stroke={colorAt(si)} strokeWidth={2} />
                  {s.values.map((v, i) => {
                    const x = MARGIN.left + i * bandWidth + bandWidth / 2;
                    const h = domainMax > 0 ? (v / domainMax) * plotH : 0;
                    const y = MARGIN.top + plotH - h;
                    return (
                      <circle
                        key={i}
                        className="loom-dot"
                        style={{ animationDelay: `${i * 25}ms` }}
                        cx={x}
                        cy={y}
                        r={2.75}
                        fill={colorAt(si)}
                      />
                    );
                  })}
                </g>
              );
            })}
          </g>
        )}

        {categories.map((cat, i) => {
          const x = MARGIN.left + i * bandWidth + bandWidth / 2;
          const y = MARGIN.top + plotH + 16;
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor={rotateLabels ? "end" : "middle"}
              transform={rotateLabels ? `rotate(-40 ${x} ${y})` : undefined}
              fontSize={9}
              fill="var(--dim)"
            >
              {truncateLabel(cat, rotateLabels ? 14 : 10)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

const PIE_MAX_SLICES = 8;
const PIE_LABEL_MIN_FRACTION = 0.04;

function PieChart({ rows, xKey, yKey }: { rows: DataRecord[]; xKey: string; yKey: string | undefined }) {
  if (!yKey) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>{EMPTY_MESSAGE}</p>;
  }

  const totals = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    const value = toFiniteNumber(row[yKey]);
    if (value === undefined) continue;
    const cat = String(row[xKey] ?? "");
    if (!totals.has(cat)) {
      totals.set(cat, 0);
      order.push(cat);
    }
    totals.set(cat, (totals.get(cat) ?? 0) + value);
  }

  let groups = order.map((label) => ({ label, value: totals.get(label) ?? 0 }));
  groups.sort((a, b) => b.value - a.value);

  if (groups.length > PIE_MAX_SLICES) {
    const kept = groups.slice(0, PIE_MAX_SLICES - 1);
    const rest = groups.slice(PIE_MAX_SLICES - 1);
    const otherValue = rest.reduce((sum, g) => sum + g.value, 0);
    groups = [...kept, { label: "Other", value: otherValue }];
  }

  const total = groups.reduce((sum, g) => sum + g.value, 0);
  if (!groups.length || total <= 0) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>{EMPTY_MESSAGE}</p>;
  }

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const outerR = Math.min(WIDTH, HEIGHT) / 2 - 62;
  const innerR = outerR * 0.55;

  let cursor = 0;
  const slices = groups.map((g, i) => {
    const fraction = g.value / total;
    const startAngle = cursor * 360;
    cursor += fraction;
    const endAngle = cursor * 360;
    return { ...g, fraction, startAngle, endAngle, color: colorAt(i) };
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        {slices.map((s, i) => (
          <div
            key={`${s.label}-${i}`}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--mute)" }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: s.color,
                display: "inline-block",
                flex: "none",
              }}
            />
            {truncateLabel(s.label || "(blank)", 20)} · {formatCompact(s.value)} · {formatPercent(s.fraction)}
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
      >
        <style>{`
          .loom-slice { animation: loom-slice-in .4s ease both; transform-box: fill-box; transform-origin: center; }
          @keyframes loom-slice-in { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: scale(1); } }
        `}</style>
        <g>
          {slices.map((s, i) => {
            if (s.endAngle <= s.startAngle) return null;
            const span = s.endAngle - s.startAngle;
            const cappedEnd = span >= 359.99 ? s.startAngle + 359.99 : s.endAngle;
            return (
              <path
                key={`${s.label}-${i}`}
                className="loom-slice"
                style={{ animationDelay: `${i * 35}ms` }}
                d={donutSlicePath(cx, cy, outerR, innerR, s.startAngle, cappedEnd)}
                fill={s.color}
                stroke="var(--bg)"
                strokeWidth={1}
              />
            );
          })}
        </g>
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={16} fontWeight={600} fill="var(--ink)">
          {formatCompact(total)}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize={9} fill="var(--dim)">
          total
        </text>
        {slices.map((s, i) => {
          if (s.fraction < PIE_LABEL_MIN_FRACTION) return null;
          const midAngle = (s.startAngle + s.endAngle) / 2;
          const leaderStart = polarToCartesian(cx, cy, outerR + 3, midAngle);
          const labelPoint = polarToCartesian(cx, cy, outerR + 16, midAngle);
          const anchorRight = labelPoint.x >= cx;
          return (
            <g key={`label-${s.label}-${i}`}>
              <line
                x1={leaderStart.x}
                y1={leaderStart.y}
                x2={labelPoint.x}
                y2={labelPoint.y}
                stroke="var(--line-soft)"
                strokeWidth={1}
              />
              <text
                x={labelPoint.x + (anchorRight ? 4 : -4)}
                y={labelPoint.y}
                textAnchor={anchorRight ? "start" : "end"}
                dominantBaseline="middle"
                fontSize={9}
                fill="var(--dim)"
              >
                {truncateLabel(s.label || "(blank)", 12)} {formatPercent(s.fraction)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function colorAt(i: number): string {
  return COLORS[i % COLORS.length] ?? COLORS[0];
}

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Groups rows by `spec.x` and reduces each `spec.y` field to its mean per group (dollars/latency
 * are rates, not counts — summing them would be meaningless, unlike the pie's totals). Caps the
 * result at `CHART_GROUP_CAP` groups, keeping the largest by the first series' mean, and returns a
 * caption describing the aggregation so the UI never looks like it's showing raw rows.
 */
function aggregateByCategory(
  rows: DataRecord[],
  spec: ChartSpec,
  fieldLabel: (key: string) => string,
): { categories: string[]; series: { key: string; label: string; values: number[] }[]; caption: string } {
  type Accumulator = { sums: number[]; counts: number[] };
  const acc = new Map<string, Accumulator>();
  const order: string[] = [];

  for (const row of rows) {
    const cat = String(row[spec.x] ?? "");
    let existing = acc.get(cat);
    if (!existing) {
      existing = { sums: spec.y.map(() => 0), counts: spec.y.map(() => 0) };
      acc.set(cat, existing);
      order.push(cat);
    }
    const group: Accumulator = existing;
    spec.y.forEach((key, si) => {
      const value = toFiniteNumber(row[key]);
      if (value === undefined) return;
      group.sums[si] = (group.sums[si] ?? 0) + value;
      group.counts[si] = (group.counts[si] ?? 0) + 1;
    });
  }

  let groups = order
    .map((label) => {
      const g = acc.get(label);
      const means = spec.y.map((_, si) => {
        const count = g?.counts[si] ?? 0;
        if (count <= 0) return undefined;
        const sum = g?.sums[si] ?? 0;
        return roundMean(sum / count);
      });
      return { label, means };
    })
    // A group with no finite value in any series carries nothing to plot — drop it.
    .filter((g) => g.means.some((m) => m !== undefined));

  const totalGroups = groups.length;
  groups.sort((a, b) => (b.means[0] ?? -Infinity) - (a.means[0] ?? -Infinity));

  const hiddenCount = Math.max(0, totalGroups - CHART_GROUP_CAP);
  if (groups.length > CHART_GROUP_CAP) {
    groups = groups.slice(0, CHART_GROUP_CAP);
  }

  const categories = groups.map((g) => g.label);
  const series = spec.y.map((key, si) => ({
    key,
    label: fieldLabel(key),
    values: groups.map((g) => g.means[si] ?? 0),
  }));

  let caption = `Mean of ${rows.length} row${rows.length === 1 ? "" : "s"} across ${totalGroups} group${
    totalGroups === 1 ? "" : "s"
  }.`;
  if (hiddenCount > 0) {
    caption += ` Showing top ${CHART_GROUP_CAP}, ${hiddenCount} hidden.`;
  }

  return { categories, series, caption };
}

/** Rounds a mean to a sensible precision, clearing the noisy floating-point tail left by division. */
function roundMean(value: number): number {
  return Math.round(value * 100) / 100;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const residual = value / magnitude;
  let niceResidual: number;
  if (residual > 5) niceResidual = 10;
  else if (residual > 2) niceResidual = 5;
  else if (residual > 1) niceResidual = 2;
  else niceResidual = 1;
  return niceResidual * magnitude;
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => (Math.round(v * 10) / 10).toString();
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return trim(n);
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return "";
  const rad = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rad} Q${x},${y} ${x + rad},${y} L${x + w - rad},${y} Q${x + w},${y} ${x + w},${y + rad} L${x + w},${y + h} Z`;
}

/** Unlike `toNumber`, missing/unparseable values are `undefined` (skip) rather than 0. */
function toFiniteNumber(v: string | number | null | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** Path for one donut slice: an annular sector between innerR and outerR, from startAngle to endAngle (degrees, clockwise from top). */
function donutSlicePath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}
