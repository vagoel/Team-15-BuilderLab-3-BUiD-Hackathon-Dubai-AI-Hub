/**
 * Mock data source, served over HTTP by the Vite dev plugin as real CSV.
 *
 * This exists so the UI can be exercised at realistic scale without spending a
 * context.dev extraction credit. It is deliberately a *network* API rather than an
 * in-process fixture: the agent calls it the same way it calls anything else, and the
 * research path stays honest about what a dataset is.
 *
 * Everything here is generated from a fixed seed, so the same request always returns
 * the same rows — a demo that changes shape between rehearsal and stage is worse
 * than no demo.
 */

export interface MockTable {
  name: string;
  description: string;
  columns: string[];
  /** Default row count when the caller doesn't ask for one. */
  defaultRows: number;
  build: (rows: number) => Array<Array<string | number>>;
}

/** Mulberry32 — small deterministic PRNG. Same seed, same table, every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

const REGIONS = ["EMEA", "APAC", "North America", "LATAM"] as const;
const PRODUCTS = ["Atlas", "Beacon", "Cobalt", "Drift", "Ember"] as const;
const REPS = ["Amina", "Rahul", "Chen", "Fatima", "Diego", "Nadia", "Omar", "Priya"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DEPARTMENTS = ["Engineering", "Design", "Sales", "Support", "Operations", "Finance"] as const;
const CITIES = ["Dubai", "Singapore", "London", "São Paulo", "Nairobi", "Tokyo"] as const;

export const TABLES: Record<string, MockTable> = {
  sales: {
    name: "sales",
    description:
      "Sales pipeline: region, rep, product, units and revenue by month. Good for a chart " +
      "grouped by region or product, and for filtering on revenue.",
    columns: ["region", "rep", "product", "month", "units", "revenue_usd"],
    defaultRows: 120,
    build(rows) {
      const r = rng(1);
      return Array.from({ length: rows }, () => {
        const units = 5 + Math.floor(r() * 240);
        const unitPrice = 180 + r() * 900;
        return [
          pick(r, REGIONS),
          pick(r, REPS),
          pick(r, PRODUCTS),
          pick(r, MONTHS),
          units,
          round(units * unitPrice, 0),
        ];
      });
    },
  },

  employees: {
    name: "employees",
    description:
      "Headcount: name, department, role, tenure and salary. Good for salary distribution " +
      "by department.",
    columns: ["name", "department", "role", "tenure_years", "salary_usd"],
    defaultRows: 100,
    build(rows) {
      const r = rng(2);
      const first = ["Sara", "Yusuf", "Lena", "Tom", "Aisha", "Marco", "Hana", "Ravi", "Zoe", "Ken"];
      const last = ["Haddad", "Silva", "Novak", "Okafor", "Kaur", "Meyer", "Tanaka", "Rossi"];
      const levels = ["Associate", "Mid", "Senior", "Staff", "Principal"];
      return Array.from({ length: rows }, (_, i) => {
        const levelIndex = Math.floor(r() * levels.length);
        const tenure = round(0.5 + r() * 11, 1);
        return [
          `${first[i % first.length]} ${pick(r, last)}`,
          pick(r, DEPARTMENTS),
          `${levels[levelIndex]} ${pick(r, ["Engineer", "Designer", "Analyst", "Manager"])}`,
          tenure,
          round(58_000 + levelIndex * 27_000 + tenure * 3_400 + r() * 9_000, 0),
        ];
      });
    },
  },

  models: {
    name: "models",
    description:
      "Language model pricing across vendors: context window, input and output cost per " +
      "million tokens, latency. Good for price comparison charts.",
    columns: ["vendor", "model", "context_k", "input_per_m", "output_per_m", "latency_ms"],
    defaultRows: 108,
    build(rows) {
      const vendors = [
        ["Northwind AI", 3.2],
        ["Solstice Labs", 1.8],
        ["Meridian", 5.4],
        ["Harbour Compute", 0.9],
        ["Vantage", 2.6],
        ["Kestrel", 4.1],
      ] as const;
      const families = ["nano", "mini", "standard", "pro", "ultra", "reasoning"];
      const contexts = [8, 32, 128];

      const out: Array<Array<string | number>> = [];
      for (const [vendor, base] of vendors) {
        families.forEach((family, fi) => {
          contexts.forEach((ctx, ci) => {
            const input = round(base * (fi + 1) * (1 + ci * 0.45));
            out.push([vendor, `${family}-${ctx}k`, ctx, input, round(input * 3.1), 120 + fi * 90 + ci * 40]);
          });
        });
      }
      return out.slice(0, rows);
    },
  },

  weather: {
    name: "weather",
    description:
      "Monthly climate by city: average temperature, rainfall and humidity. Good for a line " +
      "chart over months.",
    columns: ["city", "month", "avg_temp_c", "rainfall_mm", "humidity_pct"],
    defaultRows: 72,
    build(rows) {
      const r = rng(4);
      const out: Array<Array<string | number>> = [];
      for (const city of CITIES) {
        MONTHS.forEach((month, mi) => {
          const seasonal = Math.sin((mi / 12) * Math.PI * 2);
          out.push([
            city,
            month,
            round(24 + seasonal * 9 + r() * 3, 1),
            Math.round(Math.max(0, 60 + seasonal * -45 + r() * 40)),
            Math.round(45 + r() * 40),
          ]);
        });
      }
      return out.slice(0, rows);
    },
  },

  market_share: {
    name: "market_share",
    description: "Small table of vendor market share percentages. Built for a pie chart.",
    columns: ["vendor", "share_pct"],
    defaultRows: 7,
    build() {
      return [
        ["Northwind AI", 34.2],
        ["Solstice Labs", 24.8],
        ["Meridian", 15.1],
        ["Harbour Compute", 11.6],
        ["Vantage", 7.3],
        ["Kestrel", 4.4],
        ["Everyone else", 2.6],
      ];
    },
  },

  numbers: {
    name: "numbers",
    description:
      "Plain arithmetic: n with its square, cube and root. Useful for checking how the " +
      "table and axes behave at scale, with no domain to argue about.",
    columns: ["n", "square", "cube", "root", "parity"],
    defaultRows: 120,
    build(rows) {
      return Array.from({ length: rows }, (_, i) => {
        const n = i + 1;
        return [n, n * n, n * n * n, round(Math.sqrt(n), 3), n % 2 === 0 ? "even" : "odd"];
      });
    },
  },
};

function escapeCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: MockTable, rows: number): string {
  const body = table.build(rows).map((row) => row.map(escapeCell).join(","));
  return [table.columns.join(","), ...body].join("\n");
}

export function catalogue() {
  return Object.values(TABLES).map((t) => ({
    name: t.name,
    description: t.description,
    columns: t.columns,
    rows: t.defaultRows,
  }));
}
