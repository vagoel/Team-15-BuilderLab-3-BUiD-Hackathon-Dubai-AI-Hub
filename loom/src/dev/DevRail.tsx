import { useLoom } from "../store.js";
import { SHOWCASES, loadShowcase, setChartFields, setChartKind } from "./showcase.js";

/**
 * Dev harness. Drives the same store actions the agent's tools drive, so anything
 * that works here works by voice — and nothing here costs a research credit.
 */
export function DevRail({ onClose }: { onClose: () => void }) {
  const spec = useLoom((s) => s.spec);
  const datasets = useLoom((s) => s.datasets);
  const reset = useLoom((s) => s.reset);
  const focusComponent = useLoom((s) => s.focusComponent);
  const setFilter = useLoom((s) => s.setFilter);
  const getUiState = useLoom((s) => s.getUiState);

  const chart = spec?.components.find((c) => c.id === "auto_chart");
  const chartKind = chart && chart.type === "chart" ? chart.kind : null;
  const table = spec?.components.find((c) => c.id === "auto_table");
  const activeFilters = table && "filters" in table ? table.filters : [];
  const datasetId = Object.keys(datasets)[0];

  const filterBoth = (filters: Parameters<typeof setFilter>[1]) => {
    setFilter("auto_table", filters);
    setFilter("auto_chart", filters);
  };

  return (
    <aside className="chat">
      <div style={head}>
        <div style={{ fontWeight: 750, letterSpacing: "-0.02em", fontSize: 17 }}>Loom</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={badge}>dev</span>
          <button onClick={onClose} style={closeBtn} title="Back to the voice rail">
            ✕
          </button>
        </div>
      </div>

      <div className="scroll" style={body}>
        <p style={note}>
          Sample data, generated locally — no research call, no credits. These buttons
          hit the same store actions the agent's tools hit.
        </p>

        <Group label="research → auto-render">
          {SHOWCASES.map((s) => (
            <Btn key={s.id} onClick={() => loadShowcase(s.id)} sub={s.note}>
              {s.label}
            </Btn>
          ))}
          <Btn onClick={reset} muted>
            Clear canvas
          </Btn>
        </Group>

        <Group label="update_component — chart kind">
          <Row>
            {(["bar", "line", "pie"] as const).map((k) => (
              <Pill key={k} active={chartKind === k} disabled={!chart} onClick={() => setChartKind(k)}>
                {k}
              </Pill>
            ))}
          </Row>
          {datasetId === "ds_models" && (
            <Row>
              <Pill onClick={() => setChartFields("family", "input_per_m")} disabled={!chart}>
                by family
              </Pill>
              <Pill onClick={() => setChartFields("vendor", "input_per_m")} disabled={!chart}>
                by vendor
              </Pill>
              <Pill onClick={() => setChartFields("vendor", "latency_ms")} disabled={!chart}>
                latency
              </Pill>
            </Row>
          )}
          {!chart && <div style={hint}>load a showcase first</div>}
        </Group>

        <Group label="set_filter">
          {datasetId === "ds_numbers" && (
            <>
              <Btn onClick={() => filterBoth([{ field: "n", op: "lte", value: 25 }])} disabled={!spec}>
                “only the first twenty-five”
              </Btn>
              <Btn onClick={() => filterBoth([{ field: "parity", op: "eq", value: "even" }])} disabled={!spec}>
                “just the even ones”
              </Btn>
            </>
          )}
          {datasetId === "ds_models" && (
            <>
              <Btn onClick={() => filterBoth([{ field: "input_per_m", op: "lt", value: 5 }])} disabled={!spec}>
                “under five dollars per million”
              </Btn>
              <Btn onClick={() => filterBoth([{ field: "context_k", op: "gte", value: 128 }])} disabled={!spec}>
                “only the long-context ones”
              </Btn>
              <Btn onClick={() => filterBoth([{ field: "vendor", op: "contains", value: "Harbour" }])} disabled={!spec}>
                “just Harbour Compute”
              </Btn>
            </>
          )}
          <Btn onClick={() => filterBoth([])} disabled={!activeFilters.length} muted>
            Clear filter
          </Btn>
          {activeFilters.length > 0 && (
            <div style={hint}>
              {activeFilters.map((f) => `${f.field} ${f.op} ${f.value}`).join(" · ")}
            </div>
          )}
        </Group>

        <Group label="focus_component">
          <Row>
            {["auto_stats", "auto_chart", "auto_table", "auto_findings", "auto_sources"].map((id) => (
              <Pill key={id} onClick={() => focusComponent(id)} disabled={!spec}>
                {id.replace("auto_", "")}
              </Pill>
            ))}
          </Row>
        </Group>

        <Group label="get_ui_state">
          <Btn onClick={() => console.log(getUiState())} disabled={!spec} muted>
            log to console
          </Btn>
          {spec && (
            <div style={hint}>
              {getUiState()
                .components.map((c) => `${c.type}${c.visibleRows !== undefined ? ` (${c.visibleRows})` : ""}`)
                .join(" · ")}
            </div>
          )}
        </Group>
      </div>
    </aside>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={groupLabel}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{children}</div>;
}

function Btn({
  children,
  sub,
  onClick,
  disabled,
  muted,
}: {
  children: React.ReactNode;
  sub?: string;
  onClick: () => void;
  disabled?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        textAlign: "left",
        padding: "9px 12px",
        borderRadius: 8,
        border: "1px solid var(--line)",
        background: muted ? "transparent" : "var(--panel-2)",
        color: disabled ? "var(--dim)" : muted ? "var(--mute)" : "var(--ink)",
        fontSize: 13.5,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        lineHeight: 1.35,
      }}
    >
      {children}
      {sub && <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>{sub}</div>}
    </button>
  );
}

function Pill({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 11px",
        borderRadius: 20,
        border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
        background: active ? "var(--accent-soft)" : "var(--panel-2)",
        color: disabled ? "var(--dim)" : active ? "#8fb0ff" : "var(--mute)",
        fontSize: 12.5,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

const head: React.CSSProperties = {
  padding: "16px 18px",
  borderBottom: "1px solid var(--line)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const badge: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--warn)",
  border: "1px solid rgba(255,180,84,0.3)",
  background: "rgba(255,180,84,0.1)",
  padding: "3px 7px",
  borderRadius: 5,
  fontWeight: 700,
};

const closeBtn: React.CSSProperties = {
  color: "var(--dim)",
  fontSize: 13,
  padding: "2px 6px",
  borderRadius: 5,
  border: "1px solid var(--line)",
};

const body: React.CSSProperties = { padding: 18, overflowY: "auto", flex: 1, minHeight: 0 };

const note: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--dim)",
  marginBottom: 22,
};

const groupLabel: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--dim)",
  fontWeight: 700,
  marginBottom: 8,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const hint: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--accent)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  marginTop: 4,
  lineHeight: 1.45,
};
